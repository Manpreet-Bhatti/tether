import type {
  createRegistry,
  Mutation,
  MutatorCtx,
  PatchOp,
} from "@tether/protocol";
import { Store, writeTx } from "./store.js";

export function applyPatch(base: Store, patch: PatchOp[]): void {
  for (const p of patch)
    if (p.op === "clear") base.clear();
    else base.commit(new Map([[p.key, p.op === "put" ? p.value : undefined]]));
}

export async function rebase(
  base: Store,
  pending: readonly Mutation[],
  run: ReturnType<typeof createRegistry>,
  ctx: MutatorCtx,
): Promise<Store> {
  const view = base.clone();
  for (const m of pending) {
    const { tx, changes } = writeTx(view);
    try {
      await run(tx, m.name, m.args, ctx);
      view.commit(changes);
    } catch {}
  }
  return view;
}
