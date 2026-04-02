{
  description = "Basic Flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    pre-commit-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {nixpkgs, ...}: let
    systems = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
    forEachSystem = nixpkgs.lib.genAttrs systems;

    createSpace = system: let
      pkgs = import nixpkgs {
        inherit system;
        config = {};
      };
    in rec {
      formatter = pkgs.alejandra;

      devShells.default = pkgs.mkShell {
        packages = with pkgs; [
          # Development tooling
          git
          tokei
          ripgrep
          gh
        ];
        shellHook = ''
          echo "Welcome to root dev shell on ${system}!"
        '';
      };
    };
  in {
    devShells = forEachSystem (system: (createSpace system).devShells);
    formatter = forEachSystem (system: (createSpace system).formatter);
  };
}
