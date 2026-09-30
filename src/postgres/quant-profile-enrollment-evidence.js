/** One statement gives readers a coherent job, receipt, launch and ledger snapshot. */
export async function readProfileEnrollmentEvidence(db,jobId,{share=false}={}){
  const row=(await db.query(`SELECT to_jsonb(j) job,to_jsonb(r) receipt,to_jsonb(l) ledger,to_jsonb(x) launch
    FROM public.quant_foundation_jobs j
    LEFT JOIN public.quant_profile_enrollment_receipts r ON r.job_id=j.job_id
    LEFT JOIN public.quant_io_ledgers l ON l.job_id=j.job_id
    LEFT JOIN public.quant_io_launches x ON x.job_id=r.job_id AND x.operation_id=r.operation_id
    WHERE j.job_id=$1`+(share?' FOR SHARE OF j':''),[jobId])).rows[0];
  return row??null;
}
