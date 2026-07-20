#ifndef KERNEL_TYPES_H
#define KERNEL_TYPES_H

typedef unsigned char      uint8_t;
typedef unsigned short     uint16_t;
typedef unsigned int       uint32_t;
typedef unsigned long long uint64_t;

typedef signed char        int8_t;
typedef short              int16_t;
typedef int                int32_t;
typedef long long          int64_t;

typedef uint64_t size_t;
typedef int64_t  ssize_t;
typedef uint64_t uintptr_t;

#define NULL ((void *)0)

#define true  1
#define false 0
typedef int bool;

#endif /* KERNEL_TYPES_H */
