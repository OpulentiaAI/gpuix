import { expect, it } from 'vitest'
import { stat, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { overlaySvg, decorateBrowserImage } from './browser-media'
import { NativeBrowserHost } from './browser-host'
import sharp from 'sharp'
it('escapes overlay labels and refuses unsafe colours and coordinates',()=>{
 expect(overlaySvg([{_tag:'Label',id:'x',x:1,y:2,text:'<script>&'}],100,100)).toContain('&lt;script&gt;&amp;')
 expect(()=>overlaySvg([{_tag:'Rectangle',id:'x',x:0,y:0,width:10,height:10,color:'url(http://remote)'}],100,100)).toThrow()
 expect(()=>overlaySvg([{_tag:'Arrow',id:'x',fromX:NaN,fromY:0,toX:2,toY:2}],100,100)).toThrow()
})
it('composites overlays into native raster bytes without DOM',async()=>{
 const source=await sharp({create:{width:100,height:100,channels:4,background:'#ffffff'}}).png().toBuffer()
 const output=await decorateBrowserImage(source,[{_tag:'Highlight',id:'h',x:0,y:0,width:50,height:50}])
 expect(output.equals(source)).toBe(false);expect((await sharp(output).metadata()).width).toBe(100)
})
it.runIf(Boolean(process.env.OPULENTDEVIN_BROWSER_CDP))('records only the isolated controlled page into private MP4',async()=>{
 const host=new NativeBrowserHost()
 try{
  const initial=await host.connect()
  await host.command({_tag:'Overlay',action:'add',shape:{_tag:'Rectangle',id:'test',x:10,y:10,width:200,height:100}})
  expect((await host.frame()).bytes.equals(initial.bytes)).toBe(false)
  await host.command({_tag:'Overlay',action:'undo'});await host.command({_tag:'Overlay',action:'redo'})
  await host.command({_tag:'RecordingStart'})
  await host.command({_tag:'Type',target:{_tag:'Css',selector:'input'},text:'Controlled recording test'})
  await delay(300)
  await host.command({_tag:'Click',target:{_tag:'Text',text:'Click test',exact:true}})
  await delay(300)
  const result=await host.command({_tag:'RecordingStop'}) as {path:string;size:number;type:string}
  expect(result.type).toBe('video/mp4');expect(result.size).toBeGreaterThan(500)
  expect((await stat(result.path)).mode & 0o777).toBe(0o600)
  expect((await readFile(result.path)).subarray(4,8).toString()).toBe('ftyp')
  console.log('BROWSER_RECORDING_EVIDENCE',result.path)
 }finally{await host.disconnect()}
},30000)
