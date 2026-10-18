import { createContext, useContext, type ReactNode } from 'react';
import { useStore, type StoreApi } from 'zustand';
import type { BaaBridge } from '../bridge';
import type { ProjectService } from '../services/projectService';
import type { AppState } from './store';

export interface AppServices {
  store: StoreApi<AppState>;
  service: ProjectService;
  bridge: BaaBridge;
}

const AppContext = createContext<AppServices | null>(null);

export function AppProvider({ value, children }: { value: AppServices; children: ReactNode }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useServices(): AppServices {
  const v = useContext(AppContext);
  if (!v) throw new Error('useServices fuori da AppProvider');
  return v;
}

export function useAppStore<T>(selector: (s: AppState) => T): T {
  return useStore(useServices().store, selector);
}
