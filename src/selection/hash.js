import {isObject,digest,byCreation,byText} from './codes.js';

/**
 * registration_hash (shared by registration, ranking and the window recheck, so none of them imports another):
 * SHA-256 of the canonical JSON of the registration without the hash, with its lists in neutral order. Null when unreadable.
 */
export const registrationBody=registration=>{
  const {registration_hash:_hash,...body}=registration;
  return {...body,universe:[...(Array.isArray(body.universe)?body.universe:[])].sort(byCreation),participants:[...(Array.isArray(body.participants)?body.participants:[])].sort(byText('export_id')),
    prior_selection_ids:[...(Array.isArray(body.prior_selection_ids)?body.prior_selection_ids:[])].sort()};
};
export const registrationHashOf=registration=>isObject(registration)?digest(registrationBody(registration)):null;
