export function customerLabel(customer) {
  return (customer.firstName.trim() + " " + customer.lastName.trim()).toUpperCase();
}

export function employeeLabel(employee) {
  return (employee.firstName.trim() + " " + employee.lastName.trim()).toUpperCase();
}
