import { palettes } from './theme'

const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  settings: '<path d="M4 7h2.5M11.5 7H20M4 17h8.5M17.5 17H20"/><circle cx="9" cy="7" r="2.5"/><circle cx="15" cy="17" r="2.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  send: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="#000" stroke="none"/>',
  terminal: '<path d="m5 6 6 6-6 6m8 0h6"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M8 13h8M8 17h6"/>',
  git: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10v3a5 5 0 0 1-5 5H6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="#000"/><circle cx="12" cy="12" r="1.4" fill="#000"/><circle cx="19" cy="12" r="1.4" fill="#000"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7Z"/>',
  attach: '<path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L12 3m-7 13 9-9"/>',
} as const

export type IconName = keyof typeof paths

export function Icon({ name, size = 16, color = palettes.dark.secondary }: { name: IconName; size?: number; color?: string }) {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`
  return <svg source={source} style={{ width: size, height: size, flexShrink: 0, color }} />
}
