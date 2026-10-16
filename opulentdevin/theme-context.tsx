import { createContext, useContext, type ReactNode } from 'react'
import { palettes, type Palette } from './theme'

export const PaletteContext = createContext<Palette>(palettes.dark)
export function PaletteProvider({ palette, children }: { palette: Palette; children: ReactNode }) { return <PaletteContext.Provider value={palette}>{children}</PaletteContext.Provider> }
export function usePalette(): Palette { return useContext(PaletteContext) }
export function isActivationKey(key?: string): boolean { return ['enter', 'return', ' ', 'space'].includes(key?.toLowerCase() ?? '') }
