import { useEffect, useState } from 'react'
import { useSettings } from './useSettings'
import { LIGHT_THEME_VALUES, MONKEYTYPE_THEME_PALETTES, type ThemePalette } from '@/lib/themes'

const THEME_VARIABLES = [
  '--color-background',
  '--color-foreground',
  '--color-card',
  '--color-card-hover',
  '--color-border',
  '--color-primary',
  '--color-primary-hover',
  '--color-primary-foreground',
  '--color-muted-foreground',
  '--color-accent',
  '--color-input',
  '--color-muted',
  '--color-popover',
  '--color-destructive',
  '--color-secondary',
  '--color-secondary-foreground',
  '--color-accent-foreground',
] as const

function applyPalette(root: HTMLElement, palette: ThemePalette) {
  root.style.setProperty('--color-background', palette.bg)
  root.style.setProperty('--color-foreground', palette.text)
  root.style.setProperty('--color-card', palette.subAlt)
  root.style.setProperty('--color-card-hover', palette.subAlt)
  root.style.setProperty('--color-border', palette.sub)
  root.style.setProperty('--color-primary', palette.main)
  root.style.setProperty('--color-primary-hover', palette.main)
  root.style.setProperty('--color-primary-foreground', palette.bg)
  root.style.setProperty('--color-muted-foreground', palette.sub)
  root.style.setProperty('--color-accent', palette.subAlt)
  root.style.setProperty('--color-input', palette.subAlt)
  root.style.setProperty('--color-muted', palette.subAlt)
  root.style.setProperty('--color-popover', palette.subAlt)
  root.style.setProperty('--color-destructive', palette.error)
  root.style.setProperty('--color-secondary', palette.subAlt)
  root.style.setProperty('--color-secondary-foreground', palette.text)
  root.style.setProperty('--color-accent-foreground', palette.text)
}

function clearPalette(root: HTMLElement) {
  for (const variable of THEME_VARIABLES) root.style.removeProperty(variable)
}

export function useTheme() {
  const { preferences } = useSettings()
  const [currentTheme, setCurrentTheme] = useState<'light' | 'dark'>('dark')

  useEffect(() => {
    const theme = preferences?.theme || 'dark'
    const root = document.documentElement

    const applyTheme = (isDark: boolean, palette?: ThemePalette) => {
      if (isDark) {
        root.classList.add('dark')
        setCurrentTheme('dark')
      } else {
        root.classList.remove('dark')
        setCurrentTheme('light')
      }

      if (palette) {
        applyPalette(root, palette)
      } else {
        clearPalette(root)
      }
    }

    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      applyTheme(mediaQuery.matches)

      const listener = (e: MediaQueryListEvent) => applyTheme(e.matches)
      mediaQuery.addEventListener('change', listener)
      return () => mediaQuery.removeEventListener('change', listener)
    } else {
      applyTheme(!LIGHT_THEME_VALUES.has(theme), MONKEYTYPE_THEME_PALETTES[theme])
    }
  }, [preferences?.theme])

  return currentTheme
}
