import { createContext, useContext } from "react"

export type Theme = "dark" | "light" | "system"

export interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
}

export const ThemeContext = createContext<ThemeContextValue>({ theme: "system", setTheme: () => {} })

export function useTheme() {
  return useContext(ThemeContext)
}
