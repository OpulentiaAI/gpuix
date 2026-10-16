import { expect, it, vi } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import { NativeBrowserHost, localBrowserEndpoint } from './browser-host'
import { chromium, type BrowserContext } from 'playwright-core'
import * as fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { Browser, Page } from 'playwright-core'
import { NativeBrowserDownloads, downloadFile, MAX_DOWNLOAD_BYTES } from './browser-media-downloads'

vi.mock('node:fs/promises', async importOriginal => { const actual = await importOriginal<typeof import('node:fs/promises')>(); return { ...actual, rename: vi.fn(actual.rename) } })

it('contains download storage by validated generated identity, never suggested filename',()=>{
 expect(()=>downloadFile('/private','../../escape')).toThrow()
 expect(downloadFile('/private','00000000-0000-0000-0000-000000000000')).toBe('/private/00000000-0000-0000-0000-000000000000')
})
it('cancels non-main frames only in the owned context and preserves cancel during final rename',async()=>{
 const events=new EventEmitter()
 let directory=''
 const send=vi.fn(async(method:string,args?:{downloadPath?:string})=>{if(args?.downloadPath)directory=args.downloadPath;return {}})
 const cdp={send,on:events.on.bind(events),detach:vi.fn(async()=>{})}
 const frames=new EventEmitter()
 const target={send:async(method:string)=>method==='Target.getTargetInfo'?{targetInfo:{browserContextId:'owned-context'}}:{frameTree:{frame:{id:'main-frame'}}},on:frames.on.bind(frames),detach:async()=>{}}
 const browser={newBrowserCDPSession:async()=>cdp} as unknown as Browser
 const page={context:()=>({newCDPSession:async()=>target})} as unknown as Page
 const downloads=new NativeBrowserDownloads()
 const id='00000000-0000-0000-0000-000000000001'
 const {rename}=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
 let release:()=>void=()=>{}
 const gate=new Promise<void>(resolve=>{release=resolve})
 let renamed=false
 const spy=vi.mocked(fs.rename).mockImplementation(async(from,to)=>{await rename(from,to);renamed=true;await gate})
 try{
  await downloads.enable(browser,page)
  events.emit('Browser.downloadWillBegin',{frameId:'foreign-frame',guid:id,suggestedFilename:'ignored'})
  expect(send.mock.calls.some(([method])=>method==='Browser.cancelDownload')).toBe(false)
  frames.emit('Page.frameAttached',{frameId:'owned-child',parentFrameId:'main-frame'})
  events.emit('Browser.downloadWillBegin',{frameId:'owned-child',guid:id,suggestedFilename:'ignored'})
  expect(send).toHaveBeenCalledWith('Browser.cancelDownload',{guid:id,browserContextId:'owned-context'})
  expect(downloads.list()).toEqual([])
  events.emit('Browser.downloadWillBegin',{frameId:'main-frame',guid:id,suggestedFilename:'test'})
  await fs.writeFile(downloadFile(directory,id),'test')
  events.emit('Browser.downloadProgress',{guid:id,state:'completed',receivedBytes:4,totalBytes:4})
  await vi.waitFor(()=>expect(renamed).toBe(true))
  await downloads.cancel(id);release()
  await vi.waitFor(async()=>{await expect(fs.stat(downloadFile(directory,id)+'.download')).rejects.toThrow()})
  expect(downloads.list()[0].state).toBe('cancelled')
 }finally{release();spy.mockImplementation(rename);await downloads.close()}
})
it.runIf(Boolean(process.env.OPULENTDEVIN_BROWSER_CDP))('drags and downloads only from its explicitly created offline page',async()=>{
 const host=new NativeBrowserHost()
 let observer: Browser | undefined
 let foreign: BrowserContext | undefined
 let ownedPage: Page | undefined
 const begins: {guid:string;suggestedFilename:string}[]=[]
 const finished=new Map<string,string>()
 try{
  await host.connect()
  const html=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self' about: data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>#drag{position:absolute;left:20px;top:20px;width:100px;height:100px;background:red}</style><div id="drag">Drag test</div><output>Ready</output><button id="save" style="position:absolute;top:200px" onclick="const a=document.createElement('a');a.href='data:text/plain,offline%20test%20bytes';a.download='../../unsafe.txt';a.click()">Save fixture</button><button id="large" style="position:absolute;top:250px" onclick="const a=document.createElement('a');a.href='data:application/octet-stream;base64,'+btoa('x'.repeat(${MAX_DOWNLOAD_BYTES+1048576}));a.download='large';a.click()">Oversize fixture</button><script>let held=false;document.querySelector('#drag').onmousedown=()=>held=true;document.onmouseup=e=>{if(held&&e.clientX>200)document.querySelector('output').textContent='Dragged';held=false}</script>`
  await host.command({_tag:'Navigate',url:'data:text/html,'+encodeURIComponent(html)})
  await host.input({kind:'drag',from:{x:50,y:50},to:{x:300,y:100}})
  expect(await host.command({_tag:'Read'})).toContain('Dragged')
  await expect(host.input({kind:'drag',from:{x:-1,y:0},to:{x:20,y:20}})).rejects.toThrow('outside')
  expect(host.downloadState().enabled).toBe(false)
  const originalEnable=NativeBrowserDownloads.prototype.enable
  const enableSpy=vi.spyOn(NativeBrowserDownloads.prototype,'enable').mockImplementation(async function(this: NativeBrowserDownloads,browser,page){
    ownedPage=page
    const originalSession=browser.newBrowserCDPSession.bind(browser)
    const sessionSpy=vi.spyOn(browser,'newBrowserCDPSession').mockImplementation(async()=>{
      const session=await originalSession()
      session.on('Browser.downloadWillBegin',event=>begins.push({guid:event.guid,suggestedFilename:event.suggestedFilename}))
      session.on('Browser.downloadProgress',event=>{if(event.state!=='inProgress')finished.set(event.guid,event.state)})
      return session
    })
    try{return await originalEnable.call(this,browser,page)}finally{sessionSpy.mockRestore()}
  })
  try{await host.enableDownloads()}finally{enableSpy.mockRestore()}
  observer=await chromium.connectOverCDP(localBrowserEndpoint(),{noDefaults:true,timeout:10000})
  foreign=await observer.newContext({acceptDownloads:true,serviceWorkers:'block'})
  const foreignPage=await foreign.newPage()
  await foreignPage.goto('data:text/html,'+encodeURIComponent('<a download="foreign-test.txt" href="data:text/plain,independent%20context">Download independent fixture</a>'))
  const foreignDownloadPromise=foreignPage.waitForEvent('download')
  await foreignPage.locator('a').click()
  const foreignDownload=await foreignDownloadPromise
  expect(await foreignDownload.failure()).toBeNull()
  const foreignPath=await foreignDownload.path()
  expect(await readFile(foreignPath!,'utf8')).toBe('independent context')
  expect(host.downloadState().items).toEqual([])
  await host.command({_tag:'Click',target:{_tag:'Css',selector:'#save'}})
  await vi.waitFor(()=>expect(host.downloadState().items[0]?.state).toBe('saved'),{timeout:5000})
  const saved=host.downloadState().items[0]
  expect(saved.path).toMatch(/browser-downloads\/session-[^/]+\/[a-f0-9-]+\.download$/)
  expect(await readFile(saved.path!,'utf8')).toBe('offline test bytes')
  expect((await stat(saved.path!)).mode & 0o777).toBe(0o600)
  await host.command({_tag:'Click',target:{_tag:'Css',selector:'#large'}})
  await vi.waitFor(()=>expect(host.downloadState().items[1]?.state).toBe('cancelled'),{timeout:5000})
  expect(host.downloadState().items[1].reason).toContain('10 MiB')
  const previousBegins=begins.length
  await host.command({_tag:'Click',target:{_tag:'Css',selector:'#save'}})
  await vi.waitFor(()=>expect(begins.length).toBeGreaterThan(previousBegins),{timeout:5000})
  const overflow=begins.at(-1)!
  await vi.waitFor(()=>expect(finished.get(overflow.guid)).toBe('canceled'),{timeout:5000})
  expect(host.downloadState().items).toHaveLength(2)
  expect(host.downloadState().items.filter(item=>item.state==='saved')).toHaveLength(1)
  const beforeSubframe=begins.length
  await ownedPage!.evaluate(()=>{const frame=document.createElement('iframe');frame.id='child';frame.srcdoc='<a download="subframe.txt" href="data:text/plain,subframe">Subframe download</a>';document.body.append(frame)})
  await ownedPage!.frameLocator('#child').locator('a').click()
  await vi.waitFor(()=>expect(begins.length).toBeGreaterThan(beforeSubframe),{timeout:5000})
  const subframe=begins.at(-1)!
  await vi.waitFor(()=>expect(finished.get(subframe.guid)).toBe('canceled'),{timeout:5000})
  expect(host.downloadState().items).toHaveLength(2)
  await host.disableDownloads();expect(host.downloadState().enabled).toBe(false)
  await expect(fs.stat(downloadFile(saved.path!.replace(/\/[^/]+$/, ''),subframe.guid))).rejects.toThrow()
  expect((await host.inspect()).network.filter(item=>/^https?:/.test(item.url))).toEqual([])
 }finally{await foreign?.close();await observer?.close();await host.disconnect()}
},20000)
