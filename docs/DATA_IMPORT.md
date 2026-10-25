# Moving to Keystone: the data importer

Admins bring their records from another system with **Settings > Import data** in the portal. The server side is
`/api/data-import` (`src/routes/dataImport.ts`), the code in `src/import/`, and the background worker
`src/workers/dataImportWorker.ts`. Tables come from `migrations/2026_10_30_ks_v16_data_import.sql`.

## What can be imported

| Record type | Matched to an existing record by (within the silo) | Links it can make |
|---|---|---|
| Contacts | old-system id, then email, then phone (last 10 digits) | company (old id or name), owner (staff email) |
| Companies | old-system id, then name | owner |
| Lenders | old-system id, then name (names are unique in a copy) | - |
| Lender products | old-system id, then lender + product name | lender (old id or name; a lender named but missing is added) |
| Deals / applications | old-system id | contact, company, lender, lender product, owner |
| Notes and activities | old-system id; an exact duplicate is skipped | contact, company, deal (at least one) |
| Documents | same deal + same file content, or same contact + name + size | deal, or contact (at least one) |

A matched record is **updated** with the non-empty values from the file. The owner is only filled in when it is empty,
and tags are merged. Nothing is ever blanked out by an empty cell.

Deal stages are matched to Keystone's stages (Received, In Review, Documents Required, Additional Steps Required, Off to
Lender, Offer, Accepted, Rejected, Hold). Common CRM names are recognised ("Closed won" is Accepted, "Closed lost" is
Rejected, "Contract sent" is Offer and so on); the preview lists every stage in the file and the admin can map any of
them by hand. An unknown stage becomes Received.

Notes keep their type in the text ("Call: Intro ..."). Imported deals have `source = 'import'` and the old stage and id
in `metadata.import`. Imported documents skip OCR and the tamper scan (they were reviewed in the old system).

## Sources

* **Spreadsheet** (CSV or .xlsx, first sheet). Each record type has a template with Keystone's column names
  (`GET /api/data-import/templates/:type`); a file using them is matched automatically.
* **HubSpot, Salesforce, Pipedrive** exports. Their standard column names are matched automatically
  (`src/import/fields.ts`, `PRESETS`). Several ids in one cell (HubSpot "Associated Contact IDs") link to the first.
* **Keystone export zip** (`GET /api/export`; in the portal: Settings > Import data > Keystone export > Download this portal's data). Companies, contacts, lenders,
  lender products, deals, notes and documents (with their files) are imported in that order in one go; the old ids
  become source ids so the links between them survive, and owners are matched by email.
* **Documents**: one .zip with the files and a CSV (or .xlsx) listing each file's path in the zip, the deal id or
  contact (id or email) it belongs to, and the category.

## Steps

1. **Upload** (`POST /uploads`, multipart `file`, `source`, `record_type`). The file is stored in blob storage under
   `imports/<batch id>/`, counted, and the columns are matched to Keystone fields.
2. **Map columns** (`PUT /batches/:id/mapping`). Mappings can be saved by name and reused (`/mappings`).
3. **Preview** (`GET /batches/:id/preview`): the first rows as they will be stored, each row's errors and warnings,
   and the deal stages found.
4. **Dry run** (`POST /batches/:id/dry-run`). Runs every row in a transaction that is rolled back: the counts of
   created, updated, skipped and errors are exactly what the run will do, including duplicates within the file.
   Existing records are not changed or locked and no file is uploaded. Problems download as CSV
   (`GET /batches/:id/errors.csv?phase=dry_run`).
5. **Run** (`POST /batches/:id/run`, only after a dry run). A background job, 250 rows per transaction, progress
   saved with each chunk. A failed or interrupted run is started again and carries on after the last saved chunk.
6. **Undo** (`POST /batches/:id/undo`). Newest change first: rows the import created are deleted (with their stored
   files and anything that cascades from them, such as notes and documents added to an imported deal later), and fields
   it changed are put back to their earlier values - except a field someone has edited since, which is left as it is
   and counted as "kept". A record under an active legal hold (a held deal, its notes and documents, and its
   contact and company) is never deleted by undo; it is counted as "held".

Every upload, dry run, run and undo is written to the audit log (`audit_events`, `event_type = 'data_import'`).

## Limits

* CSV / .xlsx up to 50 MB; a zip up to 200 MB; each document up to 25 MB; up to 200,000 rows per file.
* One job runs at a time per copy (dry runs, runs and undos queue).
* The uploaded file is read into memory while a job runs; rows are then processed one at a time.
* Only the first sheet of an .xlsx is read. Old .xls files must be saved as .xlsx or CSV first.
* Contacts can only be matched within the silo the admin is working in; lenders and lender products are shared.

## Tables

* `import_batches` - one per upload: status, mapping, counts, dry-run and run summaries.
* `import_batch_items` - every row created or changed (with before and after values), what undo walks.
* `import_batch_errors` - row errors and warnings per phase (dry_run, run, undo).
* `import_external_ids` - the source system's id for each imported record (unique per silo, system, type and id).
* `import_mappings` - saved column mappings.
