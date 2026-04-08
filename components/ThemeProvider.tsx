'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'

export type AdminTheme = 'light' | 'dark'

const STORAGE_KEY = 'admin-theme'

const ThemeContext = createContext<{
  theme: AdminTheme
  setTheme: (t: AdminTheme) => void
  toggleTheme: () => void
} | null>(null)

function applyTheme(theme: AdminTheme) {
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(theme)
  root.style.colorScheme = theme === 'dark' ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<AdminTheme>('dark')

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as AdminTheme | null
      const initial = stored === 'light' || stored === 'dark' ? stored : 'dark'
      setThemeState(initial)
      applyTheme(initial)
    } catch {
      applyTheme('dark')
    }
  }, [])

  const setTheme = useCallback((t: AdminTheme) => {
    setThemeState(t)
    try {
      localStorage.setItem(STORAGE_KEY, t)
    } catch {
      /* ignore */
    }
    applyTheme(t)
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark')
  }, [theme, setTheme])

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return ctx
}
