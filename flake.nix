{
  description = "Pi coding agent";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      packageFor =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.callPackage ./nix/package.nix { source = self; };
    in
    {
      packages = forAllSystems (system: {
        default = packageFor system;
        pi = packageFor system;
      });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/pi";
          meta.description = "Pi coding agent";
        };
        pi = self.apps.${system}.default;
      });

      overlays.default = final: _previous: {
        pi = final.callPackage ./nix/package.nix { source = self; };
      };
    };
}
