/** Tenant role names (Super Admin, Group Admin, Company Admin, HR, Sales, etc.) */
const ROLES = {
  SUPER_ADMIN: 'Super Admin',
  GROUP_ADMIN: 'Group Admin',
  COMPANY_ADMIN: 'Company Admin',
  HR: 'HR',
  SALES: 'Sales',
  DEPARTMENT_HEAD: 'Department Head',
  MANAGER: 'Manager',
  EMPLOYEE: 'Employee',
};

const ROLE_PRIORITY = [
  ROLES.SUPER_ADMIN,
  ROLES.GROUP_ADMIN,
  ROLES.COMPANY_ADMIN,
  ROLES.HR,
  ROLES.SALES,
  ROLES.DEPARTMENT_HEAD,
  ROLES.MANAGER,
  ROLES.EMPLOYEE,
];

const PLATFORM_TENANT_ID = 1;

function pickPrimaryRole(roleNames = []) {
  for (const role of ROLE_PRIORITY) {
    if (roleNames.includes(role)) return role;
  }
  return roleNames[0] || null;
}

function isPlatformRole(role) {
  return role === ROLES.SUPER_ADMIN || role === ROLES.GROUP_ADMIN;
}

function canRegisterUsers(role) {
  return [ROLES.SUPER_ADMIN, ROLES.GROUP_ADMIN, ROLES.COMPANY_ADMIN].includes(role);
}

module.exports = {
  ROLES,
  ROLE_PRIORITY,
  PLATFORM_TENANT_ID,
  pickPrimaryRole,
  isPlatformRole,
  canRegisterUsers,
};
