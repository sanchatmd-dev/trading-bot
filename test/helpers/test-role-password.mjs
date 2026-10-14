/**
 * CI connects to its PostgreSQL service with a password (scram-sha-256), while local throwaway clusters use trust.
 * A test role that logs in through a URL built from TEST_DATABASE_URL keeps that URL's password, so the role needs the
 * same password or CI refuses the login with 28P01. Returns the PASSWORD clause for CREATE ROLE, or '' without one.
 */
export function rolePasswordClause(connection=process.env.TEST_DATABASE_URL){
  const password=decodeURIComponent(new URL(connection).password);
  return password?" PASSWORD '"+password.replaceAll("'","''")+"'":'';
}
