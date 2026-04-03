#include <stdio.h>

extern void qsort(long* arr, long low, long high);

void print_array(long arr[], long n) {
    for (long i = 0; i < n; i++) {
        printf("%ld ", arr[i]);
    }
    printf("\n");
}

int main() {
    long arr[] = {64, 34, 25, 12, 22, 11, 90, 88, 45, 3, 67, 5, 42, 17, 89};
    long n = sizeof(arr) / sizeof(arr[0]);

    printf("Before sorting: ");
    print_array(arr, n);

    qsort(arr, 0, n-1);

    printf("After sorting:  ");
    print_array(arr, n);

    return 0;
}
