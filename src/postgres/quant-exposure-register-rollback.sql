-- Rollback of src/postgres/quant-exposure-register.sql. Drops only the objects that file creates.
-- No CASCADE anywhere: an unexpected dependent object makes the rollback fail loudly instead of disappearing.
-- The migration tool runs this only after it classified the catalog as INSTALLED and counted zero register rows
-- (a register that holds evidence is never dropped by this file; see quant-exposure-register-migration.js).
DROP TABLE public.quant_exposure_register;
DROP FUNCTION public.quant_exposure_register_serializable_insert();
DROP FUNCTION public.quant_exposure_register_insert_only();
DROP FUNCTION public.quant_exposure_register_version();
DROP TABLE public.quant_exposure_register_schema;
