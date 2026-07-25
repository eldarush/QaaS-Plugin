# QaaS configuration

## Configuration style

{{YAML_OR_CSHARP_STYLE}}

## Composition

{{CASES_EXECUTABLES_ANCHORS_MERGE_APPEND_VARIABLES_MODULES_AND_OVERRIDES}}

## Installed package snapshot

{{PACKAGE_EVIDENCE}}

## Documentation provenance

{{APPLICABLE_DOCUMENTATION_SOURCES_AND_DIGESTS}}

## Rendered intent

{{TEMPLATE_RENDERING_EXPECTATIONS}}

## Timing and rate units

| Field or threshold | Value | Unit | Unit evidence | Meaning |
|---|---|---|---|---|
| {{FIELD}} | {{VALUE}} | {{DOCUMENTED_UNIT}} | {{CONFIG_DOC_OR_USER_EVIDENCE}} | {{MEANING}} |

Never retain a bare delay, duration, timeout, or rate value without separate
authority: current documentation/configuration proves supported meaning and
units, while direct user confirmation establishes the intended task value.
Model inference and values copied from another test remain tentative.
