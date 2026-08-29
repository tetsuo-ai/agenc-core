/*
 * Exact-record macOS Keychain adapter for AgenC's shared credential blob.
 *
 * Usage:
 *   agenc-keychain-helper read   <service> <account>
 *   agenc-keychain-helper write  <service> <account>  # secret on stdin
 *   agenc-keychain-helper delete <service> <account>
 *
 * Service and account are UTF-8 metadata. Credential bytes never appear in
 * argv or diagnostics: writes read them from stdin and reads emit them only
 * on stdout. Exit 2, with empty stderr, means exactly errSecItemNotFound.
 */

#define __STDC_WANT_LIB_EXT1__ 1

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>

#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#define SECRET_LIMIT_BYTES ((size_t)16U * 1024U * 1024U)
#define INITIAL_SECRET_CAPACITY ((size_t)4096U)
#define IDENTITY_LIMIT_BYTES ((size_t)4096U)

enum helper_exit {
  HELPER_OK = 0,
  HELPER_ERROR = 1,
  HELPER_NOT_FOUND = 2,
  HELPER_USAGE = 64
};

enum helper_operation {
  HELPER_OPERATION_READ,
  HELPER_OPERATION_WRITE,
  HELPER_OPERATION_DELETE
};

enum unique_match_result {
  UNIQUE_MATCH_ERROR = -1,
  UNIQUE_MATCH_NONE = 0,
  UNIQUE_MATCH_ONE = 1
};

enum exact_item_result {
  EXACT_ITEM_ERROR = -1,
  EXACT_ITEM_NOT_FOUND = 0,
  EXACT_ITEM_FOUND = 1
};

struct secret_buffer {
  unsigned char *data;
  size_t length;
};

static int fail_message(const char *message) {
  (void)fprintf(stderr, "agenc-keychain-helper: %s\n", message);
  return HELPER_ERROR;
}

static int fail_errno(const char *operation) {
  const int saved_errno = errno;
  (void)fprintf(stderr, "agenc-keychain-helper: %s: %s\n", operation,
                strerror(saved_errno));
  return HELPER_ERROR;
}

static int fail_osstatus(const char *operation, OSStatus status) {
  CFStringRef detail = SecCopyErrorMessageString(status, NULL);
  char detail_utf8[512];

  if ((detail != NULL) &&
      CFStringGetCString(detail, detail_utf8, sizeof detail_utf8,
                         kCFStringEncodingUTF8)) {
    (void)fprintf(stderr,
                  "agenc-keychain-helper: %s failed (OSStatus %ld: %s)\n",
                  operation, (long)status, detail_utf8);
  } else {
    (void)fprintf(stderr, "agenc-keychain-helper: %s failed (OSStatus %ld)\n",
                  operation, (long)status);
  }

  if (detail != NULL) {
    CFRelease(detail);
  }
  return HELPER_ERROR;
}

static bool parse_operation(const char *value,
                            enum helper_operation *operation_out) {
  if (strcmp(value, "read") == 0) {
    *operation_out = HELPER_OPERATION_READ;
    return true;
  }
  if (strcmp(value, "write") == 0) {
    *operation_out = HELPER_OPERATION_WRITE;
    return true;
  }
  if (strcmp(value, "delete") == 0) {
    *operation_out = HELPER_OPERATION_DELETE;
    return true;
  }
  return false;
}

/* Apple libc guarantees that memset_s calls are not removed by optimization. */
static void clear_secret_bytes(void *buffer, size_t length) {
  if ((buffer != NULL) && (length > 0U)) {
    (void)memset_s(buffer, length, 0, length);
  }
}

static void secret_buffer_dispose(struct secret_buffer *secret) {
  if (secret->data != NULL) {
    clear_secret_bytes(secret->data, secret->length);
    free(secret->data);
  }
  secret->data = NULL;
  secret->length = 0U;
}

/*
 * Read a non-empty secret shorter than SECRET_LIMIT_BYTES. On failure,
 * `secret` remains empty and owns no allocation.
 */
static int read_secret(struct secret_buffer *secret) {
  unsigned char *buffer = NULL;
  size_t capacity = INITIAL_SECRET_CAPACITY;
  size_t length = 0U;
  int result = HELPER_ERROR;

  buffer = malloc(capacity);
  if (buffer == NULL) {
    return fail_errno("cannot allocate credential input buffer");
  }

  for (;;) {
    const size_t available = capacity - length;
    const size_t count = fread(buffer + length, 1U, available, stdin);
    length += count;

    if (length >= SECRET_LIMIT_BYTES) {
      result =
          fail_message("credential input must be shorter than 16777216 bytes");
      goto cleanup;
    }
    if (count < available) {
      if (ferror(stdin)) {
        result = fail_errno("cannot read credential input");
        goto cleanup;
      }
      if (feof(stdin)) {
        break;
      }
      if (count == 0U) {
        result = fail_message("credential input made no progress");
        goto cleanup;
      }
      continue;
    }

    {
      size_t next_capacity = capacity * 2U;
      unsigned char *replacement;

      if ((next_capacity < capacity) || (next_capacity > SECRET_LIMIT_BYTES)) {
        next_capacity = SECRET_LIMIT_BYTES;
      }
      replacement = malloc(next_capacity);
      if (replacement == NULL) {
        result = fail_errno("cannot grow credential input buffer");
        goto cleanup;
      }
      memcpy(replacement, buffer, length);
      clear_secret_bytes(buffer, length);
      free(buffer);
      buffer = replacement;
      capacity = next_capacity;
    }
  }

  if (length == 0U) {
    result = fail_message("credential input must not be empty");
    goto cleanup;
  }

  secret->data = buffer;
  secret->length = length;
  return HELPER_OK;

cleanup:
  if (buffer != NULL) {
    clear_secret_bytes(buffer, length);
    free(buffer);
  }
  return result;
}

static CFStringRef create_identity(const char *value, const char *label) {
  const size_t length = strlen(value);
  CFStringRef identity;

  if ((length == 0U) || (length >= IDENTITY_LIMIT_BYTES)) {
    (void)fprintf(stderr,
                  "agenc-keychain-helper: %s must contain 1 to 4095 UTF-8 "
                  "bytes\n",
                  label);
    return NULL;
  }

  identity =
      CFStringCreateWithBytes(kCFAllocatorDefault, (const UInt8 *)value,
                              (CFIndex)length, kCFStringEncodingUTF8, false);
  if (identity == NULL) {
    (void)fprintf(stderr, "agenc-keychain-helper: %s is not valid UTF-8\n",
                  label);
  }
  return identity;
}

static OSStatus copy_user_keychain_search_list(CFArrayRef *search_list_out) {
  OSStatus status;

  *search_list_out = NULL;
#pragma clang diagnostic push
/* File-based user-domain search lists require deprecated Keychain APIs. */
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  status = SecKeychainCopyDomainSearchList(kSecPreferencesDomainUser,
                                           search_list_out);
#pragma clang diagnostic pop
  return status;
}

static CFMutableDictionaryRef create_query(CFStringRef service,
                                           CFStringRef account,
                                           CFArrayRef search_list) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  if (query == NULL) {
    return NULL;
  }

  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService, service);
  CFDictionarySetValue(query, kSecAttrAccount, account);
  CFDictionarySetValue(query, kSecMatchSearchList, search_list);
  return query;
}

static bool capture_unique_persistent_ref(CFTypeRef candidate,
                                          CFDataRef *captured_out) {
  if ((candidate == NULL) ||
      (CFGetTypeID(candidate) != CFDataGetTypeID())) {
    (void)fail_message(
        "Keychain enumeration returned a non-data persistent reference");
    return false;
  }
  if (*captured_out != NULL) {
    if (CFEqual(*captured_out, candidate)) {
      return true;
    }
    (void)fail_message(
        "multiple Keychain records match the exact service/account identity");
    return false;
  }

  *captured_out = (CFDataRef)candidate;
  CFRetain(*captured_out);
  return true;
}

/*
 * APIs that return the first generic password cannot prove uniqueness across
 * multiple file-based keychains. Build and exhaust one iterator for every
 * captured user-search-list keychain before returning a persistent reference.
 * Per-keychain iterators keep one keychain's lookup failure from being hidden
 * by another keychain's success. They return item references without password
 * data, so ambiguity is detected before any secret is decrypted or mutated.
 */
static enum unique_match_result
copy_unique_persistent_ref(CFDictionaryRef identity_query,
                           CFDataRef *persistent_ref_out) {
  CFTypeRef search_list_value =
      CFDictionaryGetValue(identity_query, kSecMatchSearchList);
  CFTypeRef service_value =
      CFDictionaryGetValue(identity_query, kSecAttrService);
  CFTypeRef account_value =
      CFDictionaryGetValue(identity_query, kSecAttrAccount);
  CFArrayRef search_list;
  char service_utf8[IDENTITY_LIMIT_BYTES];
  char account_utf8[IDENTITY_LIMIT_BYTES];
  UInt32 service_length;
  UInt32 account_length;
  SecKeychainAttribute attributes[2];
  SecKeychainAttributeList attribute_list;
  SecKeychainSearchRef search = NULL;
  CFDataRef persistent_ref = NULL;
  enum unique_match_result result = UNIQUE_MATCH_ERROR;
  OSStatus status;
  CFIndex keychain_index;

  *persistent_ref_out = NULL;
  if ((search_list_value == NULL) ||
      (CFGetTypeID(search_list_value) != CFArrayGetTypeID())) {
    (void)fail_message("Keychain identity query has no valid search list");
    return UNIQUE_MATCH_ERROR;
  }
  if ((service_value == NULL) ||
      (CFGetTypeID(service_value) != CFStringGetTypeID()) ||
      (account_value == NULL) ||
      (CFGetTypeID(account_value) != CFStringGetTypeID())) {
    (void)fail_message("Keychain identity query has invalid attributes");
    return UNIQUE_MATCH_ERROR;
  }
  if (!CFStringGetCString((CFStringRef)service_value, service_utf8,
                          sizeof service_utf8, kCFStringEncodingUTF8) ||
      !CFStringGetCString((CFStringRef)account_value, account_utf8,
                          sizeof account_utf8, kCFStringEncodingUTF8)) {
    (void)fail_message("cannot encode Keychain identity as UTF-8");
    return UNIQUE_MATCH_ERROR;
  }
  search_list = (CFArrayRef)search_list_value;
  service_length = (UInt32)strlen(service_utf8);
  account_length = (UInt32)strlen(account_utf8);
  attributes[0].tag = kSecServiceItemAttr;
  attributes[0].length = service_length;
  attributes[0].data = service_utf8;
  attributes[1].tag = kSecAccountItemAttr;
  attributes[1].length = account_length;
  attributes[1].data = account_utf8;
  attribute_list.count = 2U;
  attribute_list.attr = attributes;

  for (keychain_index = 0; keychain_index < CFArrayGetCount(search_list);
       ++keychain_index) {
    CFTypeRef keychain = CFArrayGetValueAtIndex(search_list, keychain_index);

    if (keychain == NULL) {
      (void)fail_message("Keychain search list contains a null keychain");
      goto cleanup;
    }
#pragma clang diagnostic push
/* Exact file-based enumeration requires deprecated Keychain search APIs. */
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    status = SecKeychainSearchCreateFromAttributes(
        keychain, kSecGenericPasswordItemClass, &attribute_list, &search);
#pragma clang diagnostic pop
    if (status != errSecSuccess) {
      (void)fail_osstatus("Keychain search creation", status);
      goto cleanup;
    }
    if (search == NULL) {
      (void)fail_message("Keychain search creation returned no search object");
      goto cleanup;
    }

    for (;;) {
      SecKeychainItemRef item = NULL;
      SecKeychainRef owner = NULL;
      CFDataRef candidate = NULL;

#pragma clang diagnostic push
/* The search iterator yields item references without copying secret data. */
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
      status = SecKeychainSearchCopyNext(search, &item);
#pragma clang diagnostic pop
      if (status == errSecItemNotFound) {
        if (item != NULL) {
          CFRelease(item);
        }
        break;
      }
      if (status != errSecSuccess) {
        (void)fail_osstatus("Keychain enumeration", status);
        if (item != NULL) {
          CFRelease(item);
        }
        goto cleanup;
      }
      if (item == NULL) {
        (void)fail_message("Keychain enumeration returned no item reference");
        goto cleanup;
      }
#pragma clang diagnostic push
/* File-based items expose their owning deprecated SecKeychain reference. */
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
      status = SecKeychainItemCopyKeychain(item, &owner);
#pragma clang diagnostic pop
      if (status != errSecSuccess) {
        (void)fail_osstatus("Keychain item owner lookup", status);
        if (owner != NULL) {
          CFRelease(owner);
        }
        CFRelease(item);
        goto cleanup;
      }
      if ((owner == NULL) || !CFEqual(owner, keychain)) {
        (void)fail_message(
            "Keychain enumeration returned an item from another keychain");
        if (owner != NULL) {
          CFRelease(owner);
        }
        CFRelease(item);
        goto cleanup;
      }
      CFRelease(owner);
#pragma clang diagnostic push
/* Persistent references for file-based items require a deprecated API. */
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
      status = SecKeychainItemCreatePersistentReference(item, &candidate);
#pragma clang diagnostic pop
      CFRelease(item);
      if (status != errSecSuccess) {
        (void)fail_osstatus("Keychain persistent-reference conversion",
                            status);
        if (candidate != NULL) {
          CFRelease(candidate);
        }
        goto cleanup;
      }
      if (!capture_unique_persistent_ref(candidate, &persistent_ref)) {
        if (candidate != NULL) {
          CFRelease(candidate);
        }
        goto cleanup;
      }
      CFRelease(candidate);
    }

    CFRelease(search);
    search = NULL;
  }

  if (persistent_ref == NULL) {
    return UNIQUE_MATCH_NONE;
  }
  *persistent_ref_out = persistent_ref;
  return UNIQUE_MATCH_ONE;

cleanup:
  if (search != NULL) {
    CFRelease(search);
  }
  if (persistent_ref != NULL) {
    CFRelease(persistent_ref);
  }
  return result;
}

static CFMutableDictionaryRef create_item_list_query(CFTypeRef item) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  const void *item_values[] = {item};
  CFArrayRef item_list;

  if (query == NULL) {
    return NULL;
  }
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  item_list = CFArrayCreate(kCFAllocatorDefault, item_values, 1,
                            &kCFTypeArrayCallBacks);
  if (item_list == NULL) {
    CFRelease(query);
    return NULL;
  }
  CFDictionarySetValue(query, kSecMatchItemList, item_list);
  CFRelease(item_list);
  return query;
}

/*
 * Apple requires a persistent reference to be converted with kSecReturnRef
 * before the resulting transient item reference is used for another return
 * type. Passing a persistent reference directly with kSecReturnData is an
 * invalid parameter combination on macOS.
 */
static OSStatus
copy_item_by_persistent_ref(CFDataRef persistent_ref,
                            SecKeychainItemRef *item_out) {
  CFMutableDictionaryRef query = NULL;
  CFTypeRef matched = NULL;
  OSStatus status;

  *item_out = NULL;
  query = create_item_list_query(persistent_ref);
  if (query == NULL) {
    return errSecAllocate;
  }
  CFDictionarySetValue(query, kSecReturnRef, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);

  status = SecItemCopyMatching(query, &matched);
  if (status != errSecSuccess) {
    goto cleanup;
  }
#pragma clang diagnostic push
/* Generic passwords return deprecated file-based SecKeychainItem references. */
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  if ((matched == NULL) ||
      (CFGetTypeID(matched) != SecKeychainItemGetTypeID())) {
    status = errSecParam;
    goto cleanup;
  }
#pragma clang diagnostic pop

  *item_out = (SecKeychainItemRef)matched;
  matched = NULL;

cleanup:
  if (matched != NULL) {
    CFRelease(matched);
  }
  CFRelease(query);
  return status;
}

static enum exact_item_result
copy_data_by_persistent_ref(CFDataRef persistent_ref, CFDataRef *data_out) {
  CFMutableDictionaryRef query = NULL;
  SecKeychainItemRef item = NULL;
  CFTypeRef matched = NULL;
  OSStatus status;
  enum exact_item_result result = EXACT_ITEM_ERROR;

  *data_out = NULL;
  status = copy_item_by_persistent_ref(persistent_ref, &item);
  if (status == errSecItemNotFound) {
    result = EXACT_ITEM_NOT_FOUND;
    goto cleanup;
  }
  if (status != errSecSuccess) {
    (void)fail_osstatus("Keychain exact reference lookup", status);
    goto cleanup;
  }
  query = create_item_list_query(item);
  if (query == NULL) {
    (void)fail_message("cannot allocate exact Keychain read query");
    goto cleanup;
  }
  CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);

  status = SecItemCopyMatching(query, &matched);
  if (status == errSecItemNotFound) {
    result = EXACT_ITEM_NOT_FOUND;
    goto cleanup;
  }
  if (status != errSecSuccess) {
    (void)fail_osstatus("Keychain exact read", status);
    goto cleanup;
  }
  if ((matched == NULL) || (CFGetTypeID(matched) != CFDataGetTypeID())) {
    (void)fail_message("Keychain exact read returned a non-data record");
    goto cleanup;
  }

  *data_out = (CFDataRef)matched;
  matched = NULL;
  result = EXACT_ITEM_FOUND;

cleanup:
  if (matched != NULL) {
    CFRelease(matched);
  }
  if (query != NULL) {
    CFRelease(query);
  }
  if (item != NULL) {
    CFRelease(item);
  }
  return result;
}

static OSStatus update_by_persistent_ref(CFDataRef persistent_ref,
                                         CFDictionaryRef values) {
  SecKeychainItemRef item = NULL;
  CFMutableDictionaryRef query = NULL;
  OSStatus status = copy_item_by_persistent_ref(persistent_ref, &item);

  if (status == errSecSuccess) {
    query = create_item_list_query(item);
    if (query == NULL) {
      status = errSecAllocate;
    } else {
      status = SecItemUpdate(query, values);
    }
  }
  if (query != NULL) {
    CFRelease(query);
  }
  if (item != NULL) {
    CFRelease(item);
  }
  return status;
}

static OSStatus delete_by_persistent_ref(CFDataRef persistent_ref) {
  SecKeychainItemRef item = NULL;
  CFMutableDictionaryRef query = NULL;
  OSStatus status = copy_item_by_persistent_ref(persistent_ref, &item);

  if (status == errSecSuccess) {
    query = create_item_list_query(item);
    if (query == NULL) {
      status = errSecAllocate;
    } else {
      status = SecItemDelete(query);
    }
  }
  if (query != NULL) {
    CFRelease(query);
  }
  if (item != NULL) {
    CFRelease(item);
  }
  return status;
}

static OSStatus copy_keychain_add_target(CFArrayRef search_list,
                                         SecKeychainRef *target_out) {
  SecKeychainRef target = NULL;
  OSStatus status;

  *target_out = NULL;
#pragma clang diagnostic push
/* The file-based kSecUseKeychain path requires deprecated SecKeychain APIs. */
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  status =
      SecKeychainCopyDomainDefault(kSecPreferencesDomainUser, &target);
  if (status == errSecNoDefaultKeychain) {
    if (target != NULL) {
      CFRelease(target);
    }
    target = NULL;
  }
#pragma clang diagnostic pop

  if ((status != errSecSuccess) && (status != errSecNoDefaultKeychain)) {
    goto cleanup;
  }
  if (target == NULL) {
    if ((search_list == NULL) || (CFArrayGetCount(search_list) != 1)) {
      status = errSecNoDefaultKeychain;
      goto cleanup;
    }

    target = (SecKeychainRef)CFArrayGetValueAtIndex(search_list, 0);
    if (target == NULL) {
      status = errSecInvalidKeychain;
      goto cleanup;
    }
    CFRetain(target);
  } else if ((search_list == NULL) ||
             !CFArrayContainsValue(
                 search_list, CFRangeMake(0, CFArrayGetCount(search_list)),
                 target)) {
    status = errSecInvalidKeychain;
    goto cleanup;
  }

  *target_out = target;
  target = NULL;
  status = errSecSuccess;

cleanup:
  if (target != NULL) {
    CFRelease(target);
  }
  return status;
}

/*
 * SecItemAdd routes a NULL kSecUseKeychain through defaultKeychainUI. Bind an
 * explicit, unambiguous target so this command-line helper never opens a
 * keychain-selection UI merely to choose the destination.
 */
static OSStatus add_to_default_keychain(CFMutableDictionaryRef item,
                                        CFTypeRef *added_out) {
  CFArrayRef search_list =
      (CFArrayRef)CFDictionaryGetValue(item, kSecMatchSearchList);
  SecKeychainRef target = NULL;
  OSStatus status;

  *added_out = NULL;
  status = copy_keychain_add_target(search_list, &target);
  if (status != errSecSuccess) {
    return status;
  }

  CFDictionaryRemoveValue(item, kSecMatchSearchList);
  CFDictionarySetValue(item, kSecUseKeychain, target);
  status = SecItemAdd(item, added_out);
  CFRelease(target);
  return status;
}

static bool verify_data_by_persistent_ref(CFDataRef persistent_ref,
                                          CFDataRef expected) {
  CFDataRef observed = NULL;
  const enum exact_item_result found =
      copy_data_by_persistent_ref(persistent_ref, &observed);
  bool equal = false;

  if (found == EXACT_ITEM_FOUND) {
    equal = CFEqual(observed, expected);
    if (!equal) {
      (void)fail_message(
          "Keychain post-write verification found different credential bytes");
    }
  } else if (found == EXACT_ITEM_NOT_FOUND) {
    (void)fail_message(
        "Keychain record disappeared during post-write verification");
  }
  if (observed != NULL) {
    CFRelease(observed);
  }
  return equal;
}

static bool verify_unique_identity_ref(CFDictionaryRef identity_query,
                                       CFDataRef expected_ref) {
  CFDataRef observed_ref = NULL;
  const enum unique_match_result found =
      copy_unique_persistent_ref(identity_query, &observed_ref);
  bool equal = false;

  if (found == UNIQUE_MATCH_ONE) {
    equal = CFEqual(observed_ref, expected_ref);
    if (!equal) {
      (void)fail_message("Keychain identity resolved to a different record "
                         "during verification");
    }
  } else if (found == UNIQUE_MATCH_NONE) {
    (void)fail_message("Keychain identity disappeared during verification");
  }
  if (observed_ref != NULL) {
    CFRelease(observed_ref);
  }
  return equal;
}

static int write_all(const UInt8 *bytes, size_t length) {
  size_t offset = 0U;

  while (offset < length) {
    const size_t count = fwrite(bytes + offset, 1U, length - offset, stdout);
    if (count == 0U) {
      return fail_errno("cannot write credential output");
    }
    offset += count;
  }
  if (fflush(stdout) != 0) {
    return fail_errno("cannot flush credential output");
  }
  return HELPER_OK;
}

static int read_item(CFDictionaryRef identity_query) {
  CFDataRef persistent_ref = NULL;
  CFDataRef data = NULL;
  CFIndex signed_length;
  size_t length;
  enum unique_match_result unique_match;
  enum exact_item_result exact_item;
  int result = HELPER_ERROR;

  unique_match = copy_unique_persistent_ref(identity_query, &persistent_ref);
  if (unique_match == UNIQUE_MATCH_NONE) {
    return HELPER_NOT_FOUND;
  }
  if (unique_match != UNIQUE_MATCH_ONE) {
    return HELPER_ERROR;
  }

  exact_item = copy_data_by_persistent_ref(persistent_ref, &data);
  if (exact_item == EXACT_ITEM_NOT_FOUND) {
    result = HELPER_NOT_FOUND;
    goto cleanup;
  }
  if (exact_item != EXACT_ITEM_FOUND) {
    goto cleanup;
  }

  signed_length = CFDataGetLength(data);
  if (signed_length <= 0) {
    result = fail_message("Keychain returned an empty credential record");
    goto cleanup;
  }
  length = (size_t)signed_length;
  if (length >= SECRET_LIMIT_BYTES) {
    result = fail_message(
        "Keychain credential record must be shorter than 16777216 bytes");
    goto cleanup;
  }
  if (!verify_unique_identity_ref(identity_query, persistent_ref)) {
    goto cleanup;
  }

  result = write_all(CFDataGetBytePtr(data), length);

cleanup:
  if (data != NULL) {
    CFRelease(data);
  }
  if (persistent_ref != NULL) {
    CFRelease(persistent_ref);
  }
  return result;
}

static int write_item(CFDictionaryRef identity_query) {
  struct secret_buffer secret = {NULL, 0U};
  CFDataRef secret_data = NULL;
  CFMutableDictionaryRef values = NULL;
  int result = HELPER_ERROR;
  unsigned int attempt;

  result = read_secret(&secret);
  if (result != HELPER_OK) {
    return result;
  }
  result = HELPER_ERROR;

  secret_data =
      CFDataCreateWithBytesNoCopy(kCFAllocatorDefault, secret.data,
                                  (CFIndex)secret.length, kCFAllocatorNull);
  if (secret_data == NULL) {
    result = fail_message("cannot create credential data");
    goto cleanup;
  }

  values = CFDictionaryCreateMutable(kCFAllocatorDefault, 0,
                                     &kCFTypeDictionaryKeyCallBacks,
                                     &kCFTypeDictionaryValueCallBacks);
  if (values == NULL) {
    result = fail_message("cannot allocate Keychain update attributes");
    goto cleanup;
  }
  CFDictionarySetValue(values, kSecValueData, secret_data);

  /*
   * Retry only bounded create/delete races. Every actual mutation is scoped
   * by one persistent reference, never by the service/account query.
   */
  for (attempt = 0U; attempt < 3U; attempt++) {
    CFDataRef persistent_ref = NULL;
    const enum unique_match_result unique_match =
        copy_unique_persistent_ref(identity_query, &persistent_ref);

    if (unique_match == UNIQUE_MATCH_ERROR) {
      goto cleanup;
    }
    if (unique_match == UNIQUE_MATCH_ONE) {
      const OSStatus status = update_by_persistent_ref(persistent_ref, values);

      if (status == errSecItemNotFound) {
        CFRelease(persistent_ref);
        continue;
      }
      if (status != errSecSuccess) {
        result = fail_osstatus("Keychain exact write", status);
        CFRelease(persistent_ref);
        goto cleanup;
      }
      if (!verify_data_by_persistent_ref(persistent_ref, secret_data) ||
          !verify_unique_identity_ref(identity_query, persistent_ref)) {
        CFRelease(persistent_ref);
        goto cleanup;
      }
      CFRelease(persistent_ref);
      result = HELPER_OK;
      goto cleanup;
    }

    {
      CFMutableDictionaryRef item =
          CFDictionaryCreateMutableCopy(kCFAllocatorDefault, 0, identity_query);
      CFTypeRef added = NULL;
      OSStatus status;

      if (item == NULL) {
        result = fail_message("cannot allocate Keychain item attributes");
        goto cleanup;
      }
      CFDictionarySetValue(item, kSecValueData, secret_data);
      CFDictionarySetValue(item, kSecReturnPersistentRef, kCFBooleanTrue);
      status = add_to_default_keychain(item, &added);
      CFRelease(item);

      if (status == errSecDuplicateItem) {
        if (added != NULL) {
          CFRelease(added);
        }
        continue;
      }
      if (status != errSecSuccess) {
        if (added != NULL) {
          CFRelease(added);
        }
        result = fail_osstatus("Keychain add", status);
        goto cleanup;
      }
      if ((added == NULL) || (CFGetTypeID(added) != CFDataGetTypeID())) {
        if (added != NULL) {
          CFRelease(added);
        }
        result = fail_message(
            "Keychain add returned a non-data persistent reference");
        goto cleanup;
      }

      persistent_ref = (CFDataRef)added;
      if (!verify_data_by_persistent_ref(persistent_ref, secret_data) ||
          !verify_unique_identity_ref(identity_query, persistent_ref)) {
        const OSStatus rollback_status =
            delete_by_persistent_ref(persistent_ref);
        if ((rollback_status != errSecSuccess) &&
            (rollback_status != errSecItemNotFound)) {
          (void)fail_osstatus("Keychain add rollback", rollback_status);
        }
        CFRelease(persistent_ref);
        goto cleanup;
      }
      CFRelease(persistent_ref);
      result = HELPER_OK;
      goto cleanup;
    }
  }

  result = fail_message(
      "Keychain identity changed repeatedly during the bounded write retry");

cleanup:
  if (values != NULL) {
    CFRelease(values);
  }
  if (secret_data != NULL) {
    CFRelease(secret_data);
  }
  secret_buffer_dispose(&secret);
  return result;
}

static int delete_item(CFDictionaryRef identity_query) {
  CFDataRef persistent_ref = NULL;
  enum unique_match_result unique_match;
  OSStatus status;

  unique_match = copy_unique_persistent_ref(identity_query, &persistent_ref);
  if (unique_match == UNIQUE_MATCH_NONE) {
    return HELPER_NOT_FOUND;
  }
  if (unique_match != UNIQUE_MATCH_ONE) {
    return HELPER_ERROR;
  }

  status = delete_by_persistent_ref(persistent_ref);
  CFRelease(persistent_ref);

  if (status == errSecItemNotFound) {
    return HELPER_NOT_FOUND;
  }
  if (status != errSecSuccess) {
    return fail_osstatus("Keychain delete", status);
  }
  persistent_ref = NULL;
  unique_match = copy_unique_persistent_ref(identity_query, &persistent_ref);
  if (persistent_ref != NULL) {
    CFRelease(persistent_ref);
  }
  if (unique_match == UNIQUE_MATCH_NONE) {
    return HELPER_OK;
  }
  if (unique_match == UNIQUE_MATCH_ONE) {
    return fail_message(
        "Keychain identity still has a record after exact delete");
  }
  return HELPER_ERROR;
}

int main(int argc, char **argv) {
  CFStringRef service = NULL;
  CFStringRef account = NULL;
  CFArrayRef user_search_list = NULL;
  CFMutableDictionaryRef query = NULL;
  enum helper_operation operation;
  OSStatus status;
  int result = HELPER_USAGE;

  if ((argc != 4) || !parse_operation(argv[1], &operation)) {
    (void)fprintf(stderr, "usage: agenc-keychain-helper "
                          "read|write|delete <service> <account>\n");
    return HELPER_USAGE;
  }

  service = create_identity(argv[2], "service");
  account = create_identity(argv[3], "account");
  if ((service == NULL) || (account == NULL)) {
    result = HELPER_USAGE;
    goto cleanup;
  }

  status = copy_user_keychain_search_list(&user_search_list);
  if ((status != errSecSuccess) || (user_search_list == NULL)) {
    if (status == errSecSuccess) {
      status = errSecInvalidKeychain;
    }
    result = fail_osstatus("Keychain user search-list lookup", status);
    goto cleanup;
  }

  query = create_query(service, account, user_search_list);
  if (query == NULL) {
    result = fail_message("cannot allocate Keychain query");
    goto cleanup;
  }

  switch (operation) {
  case HELPER_OPERATION_READ:
    result = read_item(query);
    break;
  case HELPER_OPERATION_WRITE:
    result = write_item(query);
    break;
  case HELPER_OPERATION_DELETE:
    result = delete_item(query);
    break;
  default:
    result = HELPER_USAGE;
    break;
  }

cleanup:
  if (query != NULL) {
    CFRelease(query);
  }
  if (user_search_list != NULL) {
    CFRelease(user_search_list);
  }
  if (account != NULL) {
    CFRelease(account);
  }
  if (service != NULL) {
    CFRelease(service);
  }
  return result;
}
