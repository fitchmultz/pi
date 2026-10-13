// Measurement-only preload: exercise the existing unsupported-platform branch.
// This is not an Android-device qualification or production configuration.
Object.defineProperty(process, "platform", { value: "android" });
