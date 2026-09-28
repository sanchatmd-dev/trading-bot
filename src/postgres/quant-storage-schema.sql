-- Optional storage ownership extension; no trading or research evidence changes.
CREATE TABLE quant_storage_schema(version INTEGER PRIMARY KEY CHECK(version=1));
INSERT INTO quant_storage_schema VALUES(1);
CREATE TABLE quant_storage_namespace(
 singleton BOOLEAN PRIMARY KEY CHECK(singleton),
 store_id UUID NOT NULL UNIQUE,
 database_hash TEXT NOT NULL CHECK(database_hash ~ '^[a-f0-9]{64}$'),
 root_hash TEXT NOT NULL CHECK(root_hash ~ '^[a-f0-9]{64}$')
);
CREATE FUNCTION quant_storage_namespace_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Storage namespace is immutable'; END $$;
CREATE TRIGGER quant_storage_namespace_immutable BEFORE UPDATE OR DELETE ON quant_storage_namespace FOR EACH ROW EXECUTE FUNCTION quant_storage_namespace_immutable();
