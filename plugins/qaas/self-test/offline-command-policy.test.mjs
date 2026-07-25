import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { analyzeProcessVector } from "../scripts/lib/shell-analyzer.mjs";
import { assertAirGapPackageSources } from "../scripts/run-approved.mjs";

test("dotnet commands cannot restore implicitly or name public NuGet", () => {
  assert.equal(
    analyzeProcessVector("dotnet", ["restore", "Tests.csproj"]).actionClass,
    "unknown",
  );
  assert.equal(
    analyzeProcessVector("dotnet", [
      "restore",
      "Tests.csproj",
      "--configfile",
      "NuGet.Config",
    ]).actionClass,
    "restore",
  );
  assert.equal(
    analyzeProcessVector("dotnet", [
      "restore",
      "Tests.csproj",
      "--configfile",
      path.resolve("outside.config"),
    ]).actionClass,
    "unknown",
  );
  assert.equal(
    analyzeProcessVector("dotnet", [
      "restore",
      "Tests.csproj",
      "--source",
      "https://api.nuget.org/v3/index.json",
    ]).actionClass,
    "unknown",
  );
  assert.equal(
    analyzeProcessVector("dotnet", ["build", "Tests.csproj"]).actionClass,
    "unknown",
  );
  assert.equal(
    analyzeProcessVector("dotnet", [
      "build",
      "Tests.csproj",
      "--no-restore",
    ]).actionClass,
    "build",
  );
  assert.equal(
    analyzeProcessVector("dotnet", [
      "run",
      "--project",
      "Tests.csproj",
      "--no-build",
      "--",
      "template",
    ]).actionClass,
    "template",
  );
});

test("runtime restore guard rejects unresolved and public project feeds", () => {
  assert.doesNotThrow(() =>
    assertAirGapPackageSources({
      packageSources: [
        { kind: "http", url: "https://artifactory.internal/nuget/" },
        { kind: "local-or-relative", value: "./packages" },
      ],
    })
  );
  assert.throws(
    () =>
      assertAirGapPackageSources({
        packageSources: [
          { kind: "http", url: "https://api.nuget.org/v3/index.json" },
        ],
      }),
    /public NuGet source/u,
  );
  assert.throws(
    () =>
      assertAirGapPackageSources({
        packageSources: [{ kind: "unresolved-project-expression" }],
      }),
    /unresolved/u,
  );
});
