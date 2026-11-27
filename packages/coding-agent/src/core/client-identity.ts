import { type ClientIdentity, PI_ATTRIBUTION } from "@earendil-works/pi-ai";
import type { GoogleAiPlanClient } from "@earendil-works/pi-ai/providers/google-ai-plan";
import { VERSION } from "../config.ts";

/**
 * Upstream Pi's Google Desktop app OAuth client for the Google AI Ultra plan, carried intact in this personal fork.
 * Google approves clients per app; other apps need their own client. The installed-app secret is non-confidential
 * (RFC 8252 §8.5). Loopback redirect, PKCE and DPoP protect the user's sign-in.
 */
export const PI_GOOGLE_AI_PLAN_CLIENT: GoogleAiPlanClient = {
	clientId: "1023131902207-qip7ip8p3hl0hi4cptjkv2dkigkt03om.apps.googleusercontent.com",
	clientSecret: "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",
};

/**
 * How pi's requests identify it to providers: a detailed `User-Agent` with pi's version, and attribution to pi as a
 * CLI agent.
 */
export function getClientIdentity(): ClientIdentity {
	return {
		userAgent: "detailed",
		version: VERSION,
		attribution: PI_ATTRIBUTION,
	};
}
