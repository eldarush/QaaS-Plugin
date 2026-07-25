# External Type A hook boundary

This plugin may author only a QaaS extension that current documentation proves is an externally discoverable Type A assertion, generator, probe, or mocker processor.

For an existing or proposed hook, capture:

- applicable current documentation and installed package evidence
- documented contract and discovery mechanism
- configuration-record fields and meanings
- package or project source
- existing YAML/C# call sites
- why configuration or a verified shared hook cannot express the requirement
- build result
- actual discovery/configuration verification

Do not hard-code interface names, package IDs, signatures, or discovery syntax in this reference. Retrieve them for the installed project version.

A request for a core protocol, serializer, policy, transport, broker/database/storage implementation, or any change inside QaaS framework source is Type B/out of scope. Stop with evidence; do not approximate it with a misleading hook.

Compilation is necessary but not sufficient. The configured hook must be discoverable under the project's actual runtime/template path.
