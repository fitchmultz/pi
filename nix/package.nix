{
  autoPatchelfHook,
  brotli,
  fd,
  fetchurl,
  importNpmLock,
  lib,
  libxcb,
  llhttp,
  makeWrapper,
  newScope,
  nodejs_22,
  ripgrep,
  source,
  sqlite,
  stdenv,
  wl-clipboard,
  xclip,
}:

let
  nodeVersion = "22.23.5";
  nodeSource = fetchurl {
    url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}.tar.xz";
    sha256 = "6cce7c58bf058700c643944903d60a325e8c9ceede1f5c2c088b435f2ada091a";
  };
  # Keep the pinned platform dependencies, including Intel Darwin, while applying
  # Node's security update to both its source and its shared libraries.
  nodejs = nodejs_22.override (previousArgs: {
    nodejs-slim = (previousArgs.nodejs-slim.override {
      callPackage = newScope {
        brotli = brotli.overrideAttrs (previous: {
          version = "1.2.1";
          src = fetchurl {
            url = "https://github.com/google/brotli/archive/refs/tags/v1.2.1.tar.gz";
            sha256 = "98d35d11a78dc453aebb7d10c3748f3f73ff78c8267c0dc697b8631f67bf7e8f";
          };
          meta = previous.meta // {
            changelog = "https://github.com/google/brotli/blob/v1.2.1/CHANGELOG.md";
          };
        });
        llhttp = llhttp.overrideAttrs {
          version = "9.4.4";
          src = nodeSource;
          sourceRoot = "node-v${nodeVersion}/deps/llhttp";
        };
        sqlite = sqlite.overrideAttrs {
          version = "3.54.1";
          src = fetchurl {
            url = "https://sqlite.org/2026/sqlite-src-3540100.zip";
            sha256 = "387e7f6cad4797b17848c07d453dc6606917bb356a6cfe5a3abafd38c240c71b";
          };
          docsrc = fetchurl {
            url = "https://sqlite.org/2026/sqlite-doc-3540100.zip";
            sha256 = "e9f634ac28a4c7b48f5c389e4b08c039654ec1487512092b330ccfcfdc0816e0";
          };
          postInstall = ''
            mkdir -p "$doc/share/doc"
            unzip "$docsrc"
            mv sqlite-doc-3540100 "$doc/share/doc/sqlite"
          '';
        };
      };
    }).overrideAttrs {
      version = nodeVersion;
      src = nodeSource;
    };
  });
  packageJson = lib.importJSON (source + "/packages/coding-agent/package.json");
  # Lockfile root used by the pi.dev installer. It pins the coding agent's
  # runtime dependency tree and is kept in sync with package-lock.json by
  # `npm run check`.
  installLock = source + "/packages/coding-agent/install-lock";
  modelCatalogPin = lib.importJSON ./model-catalog.json;
  modelCatalog = fetchurl {
    name = "pi-model-catalog.json";
    # The typed catalog is the representation whose bytes the revision hashes.
    url = "https://pi.dev/api/models/revisions/${modelCatalogPin.revision}?types=chat,image,classifier";
    sha256 = lib.removePrefix "sha256-" modelCatalogPin.revision;
  };

  workspacePackages = stdenv.mkDerivation {
    pname = "pi-workspace-packages";
    inherit (packageJson) version;
    src = source;

    npmDeps = importNpmLock { npmRoot = source; };
    npmRebuildFlags = [ "--ignore-scripts" ];

    nativeBuildInputs = [
      nodejs
      importNpmLock.npmConfigHook
    ];

    buildPhase = ''
      runHook preBuild
      node packages/ai/scripts/hydrate-model-catalog.ts ${modelCatalog}
      npm run build:offline
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      node scripts/pack-nix-packages.mjs "$out" \
        chord telemetry schema ai tui agent codemode mcp durable coding-agent

      runHook postInstall
    '';
  };

  npmDeps = importNpmLock {
    npmRoot = installLock;
    # The install lock points internal packages at registry releases. Replace
    # them with the packages built from this checkout.
    packageSourceOverrides = {
      "node_modules/@earendil-works/chord" = workspacePackages + "/chord.tgz";
      "node_modules/@earendil-works/pi-agent-core" = workspacePackages + "/agent.tgz";
      "node_modules/@earendil-works/pi-ai" = workspacePackages + "/ai.tgz";
      "node_modules/@earendil-works/pi-codemode" = workspacePackages + "/codemode.tgz";
      "node_modules/@earendil-works/pi-coding-agent" = workspacePackages + "/coding-agent.tgz";
      "node_modules/@earendil-works/pi-durable" = workspacePackages + "/durable.tgz";
      "node_modules/@earendil-works/pi-mcp" = workspacePackages + "/mcp.tgz";
      "node_modules/@earendil-works/pi-schema" = workspacePackages + "/schema.tgz";
      "node_modules/@earendil-works/pi-telemetry" = workspacePackages + "/telemetry.tgz";
      "node_modules/@earendil-works/pi-tui" = workspacePackages + "/tui.tgz";
    };
  };
in
stdenv.mkDerivation {
  pname = "pi";
  inherit (packageJson) version;
  src = installLock;
  inherit npmDeps;

  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    nodejs
    importNpmLock.npmConfigHook
    makeWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  buildInputs = [ nodejs ] ++ lib.optionals stdenv.hostPlatform.isLinux [
    stdenv.cc.cc.lib
    libxcb
  ];

  dontBuild = true;
  dontStrip = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/pi" "$out/bin"
    cp -R . "$out/lib/pi"

    # The wrapper runs Pi with an absolute Node path. Node is only on PATH so Pi can
    # find npm for package installs; append it so that shells started by the
    # bash tool keep the user's node/npm (e.g. from mise or nvm). fd, ripgrep,
    # and the clipboard tools are Pi's own dependencies and take precedence.
    makeWrapper ${nodejs}/bin/node "$out/bin/pi" \
      --add-flags "$out/lib/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" \
      --suffix PATH : ${lib.makeBinPath [ nodejs ]} \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            fd
            ripgrep
          ]
          ++ lib.optionals stdenv.hostPlatform.isLinux [
            wl-clipboard
            xclip
          ]
        )
      }

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    test "$(${nodejs}/bin/node --version)" = "v22.23.5"
    ${nodejs}/bin/node -e \
      'const assert = require("node:assert/strict");
       assert.equal(process.versions.brotli, "1.2.1");
       assert.equal(process.versions.llhttp, "9.4.4");
       assert.equal(process.versions.sqlite, "3.54.1");'
    test "$("$out/bin/pi" --version)" = "${packageJson.version}"
    # Load host-platform TUI helpers directly so missing native dependencies
    # fail the build rather than silently disabling clipboard support.
    ${nodejs}/bin/node -e \
      "const fs = require('node:fs');
       const path = require('node:path');
       const dir = '$out/lib/pi/node_modules/@earendil-works/pi-tui/native/' + process.platform + '/prebuilds/' + process.platform + '-' + process.arch;
       if (fs.existsSync(dir)) {
         for (const file of fs.readdirSync(dir)) {
           if (file.endsWith('.node')) require(path.join(dir, file));
         }
       }"
    ${nodejs}/bin/node -e \
      "require('$out/lib/pi/node_modules/@silvia-odwyer/photon-node')"
    runHook postInstallCheck
  '';

  meta = {
    description = packageJson.description;
    homepage = "https://pi.dev";
    license = lib.licenses.mit;
    mainProgram = "pi";
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
    ];
    sourceProvenance = with lib.sourceTypes; [
      fromSource
      binaryNativeCode
    ];
  };
}
