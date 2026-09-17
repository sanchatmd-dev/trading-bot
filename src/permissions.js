// Unknown roles have no permissions. Support never receives credentials or trading writes.
const grants={
  USER:['own:read','own:write'],
  SUPPORT:['own:read','own:write','users:read','operations:read'],
  ADMIN:['own:read','own:write','users:read','users:write','operations:read','licenses:read','licenses:write','trading:pause','analytics:any']
};
export const permissionsFor=role=>grants[role]||[];
export const hasPermission=(user,permission)=>permissionsFor(user?.role).includes(permission);
export const privileged=user=>['ADMIN','SUPPORT'].includes(user?.role);
export function adminPermission(method,path){
  if(path==='/api/admin/health'&&method==='GET')return 'operations:read';
  if(path==='/api/admin/users'&&method==='GET')return 'users:read';
  if(path.startsWith('/api/admin/users')&&['POST','PUT'].includes(method))return 'users:write';
  if(path==='/api/admin/licenses'&&method==='GET')return 'licenses:read';
  if(path.startsWith('/api/admin/licenses')&&['POST','PUT'].includes(method))return 'licenses:write';
  if(path==='/api/admin/global-kill'&&method==='POST')return 'trading:pause';
  return null;
}
