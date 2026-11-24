import type { ProviderImages } from "../types.ts";

export const googleImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./google-images.ts")).generateImages(model, context, options),
});
