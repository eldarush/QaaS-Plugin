---
description: Plan or apply safe, schema-aware QaaS sample changes without guessing field semantics.
user-invocable: false
---

# Work with QaaS samples

`qaas-workflow` exclusively owns lifecycle phase selection, authoritative
state, readiness, reviews, and approvals. This domain skill accepts only its
bounded current envelope and returns results to that coordinator.

Before changing or generating JSON, XML, Protobuf, binary, or other project samples, establish:

- format and schema or descriptor
- relevant field and header meanings
- correlation rules
- mutable and immutable fields
- exact rule for every mutation
- create-new versus modify-existing choice
- whether AI editing or a documented generator is allowed
- expected response and assertion
- nondeterministic fields and comparison treatment

Obtain missing semantics from current documentation, direct user confirmation, or approved schema/runtime evidence. Project examples are convention evidence, not behavioral authority. Ask through the coordinator one question at a time and do not proceed with a semantic unknown.

During implementation, require a fresh approved plan and exact paths. Make the smallest valid edit, preserve encoding and project layout, never persist credentials, and never delete/move/rename. For binary content, use only an approved deterministic tool and hash-bound inputs; do not improvise opaque shell transformations.

Return mutation rules, protected fields, changed paths, hashes when applicable, and verification needed.

See [sample contract](../../references/samples/sample-contract.md).
