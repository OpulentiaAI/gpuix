import { activateNativeRuntime } from './install-native'

activateNativeRuntime()
await import(new URL('./main.js', import.meta.url).href)
