# Partner API addendum — per-resident app adoption

**Status:** requested, not yet implemented upstream.
**Requested by:** Qonshu CRM (sales side).
**Why:** the CRM must show, for one building, the list of residents who have **not** installed
the mobile app, so a sales manager can follow them up individually.

## The gap

The current contract (`docs/partner-api-contract.md`) exposes app adoption only as aggregates on
`GET /api/qonshu/partner-stats/`:

| Field | Meaning |
|---|---|
| `total_installations` | how many users installed the app |
| `ios_installations` / `android_installations` | split by platform |
| `logged_in_users` | users with an active app token |

These are counts. They answer *how many* installed, never *which residents did not*. Nothing in
`GET /api/qonshu/objects/` carries device-token or app state either — per unit it returns only
`owner_id`, `owner_name`, `owner_mobile`, `debt`, `balance`, `net`.

The requested screen therefore cannot be built on the published contract. It needs one of the two
options below.

## Option A (preferred): a residents endpoint

```
GET /api/qonshu/residents/?partner=<name>&has_device_token=false&page=1&page_size=100
X-API-Key: <shared key>
```

One row per **app-eligible resident**, not per unit — see "Open questions" below.

```jsonc
{
  "partner": "Acme Towers",
  "count": 128,                 // total matching rows, before pagination
  "page": 1,
  "page_size": 100,
  "page_count": 2,
  "residents": [
    {
      "id": 90231,              // stable resident id in your system
      "first_name": "Aysel",    // SEPARATE fields, not one combined string
      "last_name": "Məmmədova",
      "mobile": "+994501234567",
      "has_device_token": false,
      "device_count": 0,        // 0 = never installed
      "last_seen_at": null,     // ISO 8601, or null if never logged in
      "building": "Acme Towers A",
      "block": "B2",
      "unit_type": "APARTMENT", // APARTMENT | PARKING | PROPERTY | OFFICE
      "unit_number": "114",
      "role": "OWNER"           // OWNER | TENANT | FAMILY — see open questions
    }
  ]
}
```

Requirements:

- **`has_device_token` must be filterable server-side** (`?has_device_token=false`). A building can
  hold thousands of residents; the CRM must not page the whole set to filter client-side.
- **Paginated**, same shape as `partner-stats` (`page`, `page_size`, `page_count`) so the existing
  pager is reused.
- **Same auth and errors** as the existing endpoints: `X-API-Key`, 401 invalid key, 404 unknown
  partner, 429 on the 120/min throttle.
- `first_name` and `last_name` as separate fields. The CRM needs surname on its own and will not
  split a combined string — Azerbaijani names make that unreliable.

## Option B (cheaper, less useful): a flag on the objects response

Add to each unit in `GET /api/qonshu/objects/`:

```jsonc
{
  "owner_has_device_token": false,
  "owner_device_count": 0
}
```

This is a smaller change but it is limited to **one owner per unit**: it cannot express a tenant
who uses the app, or two residents of one apartment where only one installed it. It is acceptable
only if app users genuinely map one-to-one to units.

## Open questions for the partner backend

1. **Who counts as a "user"?** Is an app account always a unit *owner*, or can tenants and family
   members register? If the latter, Option B is insufficient and Option A must return them.
2. **Does "no device token" mean "never installed", or "installed then logged out / token
   expired"?** These need distinguishing — `device_count: 0` plus `last_seen_at: null` reads as
   never installed; a null token with a non-null `last_seen_at` is a lapsed user, who is a
   different sales conversation. If a push token is rotated or revoked on logout, say so.
3. **Is `logged_in_users` in `partner-stats` the same population** as
   `residents?has_device_token=true`? If not, the CRM's "Active on app" KPI and this list will
   disagree, and someone will report it as a bug.
4. **Are residents without a mobile number possible?** If `mobile` can be null, the CRM shows the
   row without a phone rather than hiding it.

## Privacy note (relevant to both options)

This endpoint returns residents' names and phone numbers in bulk — the most sensitive data the
integration carries. On the CRM side it will be gated to the roles that already hold
`view_object_detail` (team admin, owner, that building's partner rep) and will **not** be visible
to a sales MEMBER, consistent with the existing rule that members see general statistics only.
The partner side should assume the data is subject to the same handling as the payments list.
