import type { ProviderStreams } from "../types.ts";
import { type LazyApiCapabilities, lazyApi } from "./lazy.ts";

export const googleInteractionsApi = (
	capabilities: LazyApiCapabilities = { fetchDeferred: true, cancelDeferred: true },
): ProviderStreams => lazyApi(() => import("./google-interactions.ts"), capabilities);
