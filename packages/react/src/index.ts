import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Client, Query } from "@tether/client";

const Ctx = createContext<Client<any> | null>(null);

export function ClientProvider({
  client,
  children,
}: {
  client: Client<any>;
  children: ReactNode;
}) {
  return createElement(Ctx.Provider, { value: client }, children);
}

function useClient<M extends Record<string, any>>(): Client<M> {
  const c = useContext(Ctx);
  if (!c) throw new Error("useQuery/useMutate outside <ClientProvider>");
  return c;
}

export function useMutate<
  M extends Record<string, any> = Record<string, any>,
>() {
  return useClient<M>().mutate;
}

export function useQuery<T>(fn: Query<T>, deps: readonly unknown[] = []): T {
  const client = useClient();
  const { subscribe, get } = useMemo(() => {
    let cached: { value: T } | undefined;
    return {
      subscribe: (onChange: () => void) => {
        const off = client.subscribe(fn, (value) => {
          cached = { value };
          onChange();
        });
        cached = undefined;
        return off;
      },
      get: () => (cached ??= { value: client.read(fn) }).value,
    };
  }, [client, ...deps]);
  return useSyncExternalStore(subscribe, get);
}
