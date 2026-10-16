import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, chmod, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CDPSession, Page } from 'playwright-core'
import type { BrowserOverlayShape } from './zuse-runtime/packages/contracts/src/browser-shared'
import { dataDirectory } from './preferences'

const escape = (text: string) => text.replace(/[<>&"']/g, value => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[value]!))
export function overlaySvg(shapes: readonly BrowserOverlayShape[], width: number, height: number): string {
  if (shapes.length > 100) throw new Error('At most 100 overlays are allowed.')
  const number = (value: number) => { if (!Number.isFinite(value) || Math.abs(value) > 20000) throw new Error('Overlay coordinate outside supported bounds.'); return value }
  const items = shapes.map(shape => {
    const color = shape.color ?? '#4489ff'
    if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color)) throw new Error('Overlay colour must be hexadecimal.')
    if (shape._tag === 'Rectangle' || shape._tag === 'Highlight') { if (shape.width < 0 || shape.height < 0) throw new Error('Overlay dimensions must be nonnegative.'); return `<rect x="${number(shape.x)}" y="${number(shape.y)}" width="${number(shape.width)}" height="${number(shape.height)}" fill="${shape._tag === 'Highlight' ? color : 'none'}" fill-opacity="0.25" stroke="${color}" stroke-width="3"/>` }
    if (shape._tag === 'Label') { if (shape.text.length > 500) throw new Error('Overlay label too long.'); return `<text x="${number(shape.x)}" y="${number(shape.y)}" fill="${color}" font-size="20">${escape(shape.text)}</text>` }
    if (shape._tag === 'Arrow') return `<path d="M ${number(shape.fromX)} ${number(shape.fromY)} L ${number(shape.toX)} ${number(shape.toY)}" fill="none" stroke="${color}" stroke-width="3" marker-end="url(#arrow)"/>`
    if (shape.points.length > 2000) throw new Error('Overlay stroke too long.')
    return `<polyline points="${shape.points.map(point => `${number(point.x)},${number(point.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="3"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" fill="#4489ff"/></marker></defs>${items.join('')}</svg>`
}
export async function decorateBrowserImage(bytes: Buffer, shapes: readonly BrowserOverlayShape[]) {
  if (!shapes.length) return bytes
  const { default: sharp } = await import('sharp')
  const meta = await sharp(bytes).metadata()
  if (!meta.width || !meta.height) throw new Error('Invalid browser image.')
  return sharp(bytes).composite([{input:Buffer.from(overlaySvg(shapes,meta.width,meta.height))}]).png().toBuffer()
}
export class NativeBrowserRecording {
  private cdp: CDPSession | null = null
  private frames: {name:string;time:number}[] = []
  private pending = Promise.resolve()
  private directory = ''
  private bytes = 0
  private started = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopping: Promise<{path:string;type:string;size:number;durationMs:number}> | null = null
  private queued = 0
  private failed: Error | null = null
  private result: {path:string;type:string;size:number;durationMs:number} | null = null
  active = false
  async start(page: Page, shapes: () => readonly BrowserOverlayShape[]) {
    if (this.active || this.stopping) throw new Error('Recording already active or stopping.')
    await mkdir(join(dataDirectory,'browser-recordings'),{recursive:true,mode:0o700})
    this.directory = await mkdtemp(join(dataDirectory,'browser-recordings','recording-'))
    await chmod(this.directory,0o700)
    this.frames=[];this.bytes=0;this.queued=0;this.failed=null;this.result=null;this.pending=Promise.resolve();this.started=Date.now()
    this.cdp=await page.context().newCDPSession(page)
    this.cdp.on('Page.screencastFrame', event => {
      void this.cdp?.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{})
      if (!this.active || this.frames.length >= 1800 || this.bytes > 100*1024*1024 || this.queued >= 2) return
      this.queued++
      const time=Date.now(); const bytes=Buffer.from(event.data,'base64'); this.bytes+=bytes.length
      const name=`frame-${String(this.frames.length).padStart(5,'0')}.png`;this.frames.push({name,time})
      const captured=[...shapes()]
      this.pending=this.pending.then(async()=>{await writeFile(join(this.directory,name),await decorateBrowserImage(bytes,captured),{mode:0o600,flag:'wx'})}).catch(()=>{this.failed=new Error('Recording frame persistence failed.')}).finally(()=>{this.queued--})
    })
    this.active=true
    try { await this.cdp.send('Page.startScreencast',{format:'png',maxWidth:1920,maxHeight:1080,everyNthFrame:2});this.timer=setTimeout(()=>{void this.stop().catch(()=>{})},60000) }
    catch(error){this.active=false;await this.cdp.detach();this.cdp=null;throw error}
    return {state:'recording',startedAt:new Date(this.started).toISOString(),maximumDurationMs:60000}
  }
  stop() {
    if (this.stopping) return this.stopping
    if (!this.active) return this.result ? Promise.resolve(this.result) : Promise.reject(new Error('No recording is active.'))
    this.stopping=this.finish().then(value=>{this.result=value;return value}).finally(()=>{this.stopping=null})
    return this.stopping
  }
  private async finish() {
    this.active=false;clearTimeout(this.timer)
    try { await this.cdp?.send('Page.stopScreencast') } finally { await this.cdp?.detach();this.cdp=null }
    await this.pending
    if (this.failed) throw this.failed
    if (!this.frames.length) throw new Error('Chromium produced no recording frames.')
    const lines=this.frames.flatMap((frame,index)=>[`file '${frame.name}'`,`duration ${Math.max(0.04,((this.frames[index+1]?.time ?? Date.now())-frame.time)/1000)}`])
    lines.push(`file '${this.frames.at(-1)!.name}'`)
    await writeFile(join(this.directory,'frames.txt'),lines.join('\n'),{mode:0o600})
    const path=join(this.directory,'recording.mp4')
    await writeFile(path, Buffer.alloc(0), {mode:0o600,flag:'wx'})
    await new Promise<void>((resolve,reject)=>{
      const child=spawn('ffmpeg',['-y','-nostdin','-v','error','-f','concat','-safe','1','-i','frames.txt','-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-fs','104857600',path],{cwd:this.directory,stdio:'ignore'})
      const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Recording encoder exceeded 20 seconds.'))},20000)
      child.once('error',()=>{clearTimeout(timer);reject(new Error('ffmpeg is unavailable.'))});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Recording encoding failed.'))})
    })
    await chmod(path,0o600)
    for(const frame of this.frames) await rm(join(this.directory,frame.name))
    await rm(join(this.directory,'frames.txt'))
    return {path,type:'video/mp4',size:(await stat(path)).size,durationMs:Date.now()-this.started}
  }
}
