# Photos

The owner's own photos: resized on the phone, queued with the rest of the offline queue, re-encoded on the server, and kept private (`AGENTS.md` §1, `HANDOVER.md` §4.1). Seeded by the walking-skeleton project (#6), whose decision 2 put the queued upload path in the skeleton. No photo is published yet: the public snapshot gains photos with the public catalogue milestone. Every clause is `[seed]` until a human promotes it (`K-SPEC-8`).

**Id prefix:** `PHOTO`

## Upload

- `[PHOTO-1]` `[seed]` Before a photo is queued, the client resizes it to the configured longest edge and re-compresses it as JPEG; the server refuses an upload larger than the configured size cap with 413 before it decodes it.
- `[PHOTO-2]` `[seed]` A photo upload is idempotent by its client-generated UUID, through the same applied-mutation record as the offline-sync endpoint: the same id with the same bytes stores nothing more and returns the first result, and the same id with different bytes is refused as a conflict and logs the `businessEvent` `sync.conflict`.

## Re-encoding

- `[PHOTO-3]` `[seed]` `registerPhoto` is a typed service function with zod-validated input that only an authenticated admin can call; it re-encodes the uploaded image on the server into every stored size, the full size included, and writes only the re-encoded files, so the uploaded bytes are never written to any storage.
- `[PHOTO-4]` `[seed]` A test sends straight to the server, without the client's resize, a JPEG that carries EXIF GPS coordinates, a camera model and an orientation, and asserts that no stored size carries EXIF, XMP, IPTC or GPS data and that each is oriented as the original displayed.
- `[PHOTO-5]` `[seed]` An upload the server cannot decode or re-encode is refused, stores nothing, and logs the `businessEvent` `photo.reencode.failed` with its id and never its bytes.

## Storage

- `[PHOTO-6]` `[seed]` A stored photo's object keys are random, hold at least 128 bits from a cryptographically secure generator, are made by the server and do not contain the client's id; the photo bucket blocks all public access, no CloudFront distribution has it as an origin, and the admin sees a photo only through a presigned URL that expires within 15 minutes, issued to a valid session.
