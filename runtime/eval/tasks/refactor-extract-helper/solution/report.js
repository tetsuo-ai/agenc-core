export function formatFullName(person) {
  return (person.firstName.trim() + " " + person.lastName.trim()).toUpperCase();
}

export function customerLabel(customer) {
  return formatFullName(customer);
}

export function employeeLabel(employee) {
  return formatFullName(employee);
}
