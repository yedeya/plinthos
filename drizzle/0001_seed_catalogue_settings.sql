-- Custom SQL migration file, put your code below! --
-- The catalogue_settings singleton (brief #6, Issue D): show_values and selling_mode false,
-- public_token and selling_value_display null. Its key is CATALOGUE_SETTINGS_ID in
-- src/db/schema/catalogue-settings.ts, made by the application, never by the database ([PLAT-13]).
INSERT INTO "catalogue_settings" ("id", "public_token", "show_values", "selling_mode", "selling_value_display")
VALUES ('b1c48140-d308-424d-afdc-5f4a819a65c9', NULL, false, false, NULL);
