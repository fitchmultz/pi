/**
 * GPT-6 models that reject `reasoning.effort: "none"`, so `off` thinking is unavailable and
 * `temperature` is unsupported on OpenAI Responses endpoints.
 *
 * Kept in a leaf module without runtime dependencies so catalog pin refresh can import it before
 * workspace dependencies are installed.
 */
export const GPT_6_NO_NONE_EFFORT_MODEL_IDS: ReadonlySet<string> = new Set([
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-6.2-astra",
	"gpt-6.2-sol",
]);
