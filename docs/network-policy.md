# Outbound Network Policy

The default bridge fetch path resolves each hostname, rejects disallowed
private addresses, and connects directly to one of the validated addresses.
The request still sends the original URL host as `Host` and as TLS SNI, so the
validated address is not replaced by a second hostname lookup. If resolution
or address pinning cannot be established, the request fails closed. Each
redirect is parsed, allowlist-checked, DNS-validated, and pinned independently;
redirects also remove credential-like request headers.

`SUBPOLAR_NETWORK_ALLOWED_HOSTS` is a trusted hostname allowlist. It permits
those hostnames through hostname validation, but it does not trust their DNS
answers: private-address checks still apply unless the corresponding explicit
private/loopback environment setting is enabled. Literal IPs are subject to
the same private-address checks. Tests and callers may inject a fetch
implementation; that path remains injectable and is not the production
address-pinned transport.

Custom provider URLs reject embedded credentials and sensitive query
parameters. Discovery appends `/v1/models` to the URL pathname while
preserving its query.
