#define _GNU_SOURCE

#include <dlfcn.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_IDENTITY_BYTES (4U * 1024U)
#define MAX_SECRET_BYTES (16U * 1024U * 1024U)

#define SECRET_SCHEMA_ATTRIBUTE_STRING 0
#define SECRET_SCHEMA_DONT_MATCH_NAME (1 << 1)
#define SECRET_SERVICE_OPEN_SESSION (1 << 1)
#define SECRET_SEARCH_ALL (1 << 1)
#define SECRET_ITEM_CREATE_NONE 0

typedef int gboolean;
typedef unsigned int guint;
typedef void *gpointer;

typedef struct _GError {
  guint domain;
  int code;
  char *message;
} GError;

typedef struct _GList {
  gpointer data;
  struct _GList *next;
  struct _GList *prev;
} GList;

typedef struct _GHashTable GHashTable;
typedef struct _SecretCollection SecretCollection;
typedef struct _SecretItem SecretItem;
typedef struct _SecretSchema SecretSchema;
typedef struct _SecretService SecretService;
typedef struct _SecretValue SecretValue;

struct secret_api {
  void *library;
  size_t (*service_get_type)(void);
  SecretService *(*service_open_sync)(size_t, const char *, int, void *,
                                      GError **);
  SecretSchema *(*schema_new)(const char *, int, ...);
  void (*schema_unref)(SecretSchema *);
  GHashTable *(*hash_table_new)(guint (*)(const void *),
                                gboolean (*)(const void *, const void *));
  gboolean (*hash_table_insert)(GHashTable *, const void *, const void *);
  void (*hash_table_unref)(GHashTable *);
  guint (*str_hash)(const void *);
  gboolean (*str_equal)(const void *, const void *);
  GList *(*service_search_sync)(SecretService *, const SecretSchema *,
                                GHashTable *, int, void *, GError **);
  gboolean (*item_get_locked)(SecretItem *);
  gboolean (*item_load_secret_sync)(SecretItem *, void *, GError **);
  SecretValue *(*item_get_secret)(SecretItem *);
  gboolean (*item_set_secret_sync)(SecretItem *, SecretValue *, void *,
                                   GError **);
  gboolean (*item_delete_sync)(SecretItem *, void *, GError **);
  const char *(*dbus_proxy_get_object_path)(gpointer);
  SecretCollection *(*collection_for_alias_sync)(SecretService *, const char *,
                                                  int, void *, GError **);
  gboolean (*collection_get_locked)(SecretCollection *);
  SecretItem *(*item_create_sync)(SecretCollection *, const SecretSchema *,
                                  GHashTable *, const char *, SecretValue *,
                                  int, void *, GError **);
  SecretValue *(*value_new)(const char *, ptrdiff_t, const char *);
  const char *(*value_get)(SecretValue *, size_t *);
  void (*value_unref)(gpointer);
  void (*list_free_full)(GList *, void (*)(gpointer));
  void (*object_unref)(gpointer);
  void (*error_free)(GError *);
};

struct storage_context {
  struct secret_api *api;
  SecretService *service;
  SecretSchema *schema;
  GHashTable *attributes;
};

struct search_result {
  GList *items;
  SecretItem *item;
  size_t count;
};

static bool load_symbol(void *library, const char *name, void *target,
                        size_t target_size) {
  void *symbol;
  const char *error;

  (void)dlerror();
  symbol = dlsym(library, name);
  error = dlerror();
  if ((error != NULL) || (symbol == NULL)) {
    (void)fprintf(stderr, "Secret Service helper could not load %s: %s\n",
                  name, error != NULL ? error : "symbol unavailable");
    return false;
  }
  if (target_size != sizeof symbol) {
    (void)fprintf(stderr,
                  "Secret Service helper encountered an unsupported function-pointer ABI\n");
    return false;
  }
  (void)memcpy(target, &symbol, sizeof symbol);
  return true;
}

#define LOAD_SYMBOL(api, member, symbol_name)                                  \
  do {                                                                         \
    if (!load_symbol((api)->library, (symbol_name), &(api)->member,             \
                     sizeof((api)->member))) {                                 \
      goto load_failed;                                                        \
    }                                                                          \
  } while (0)

static bool load_secret_api(struct secret_api *api) {
  (void)memset(api, 0, sizeof *api);
  api->library = dlopen("libsecret-1.so.0", RTLD_NOW | RTLD_LOCAL);
  if (api->library == NULL) {
    (void)fprintf(stderr, "Secret Service is unavailable: %s\n", dlerror());
    return false;
  }

  LOAD_SYMBOL(api, service_get_type, "secret_service_get_type");
  LOAD_SYMBOL(api, service_open_sync, "secret_service_open_sync");
  LOAD_SYMBOL(api, schema_new, "secret_schema_new");
  LOAD_SYMBOL(api, schema_unref, "secret_schema_unref");
  LOAD_SYMBOL(api, hash_table_new, "g_hash_table_new");
  LOAD_SYMBOL(api, hash_table_insert, "g_hash_table_insert");
  LOAD_SYMBOL(api, hash_table_unref, "g_hash_table_unref");
  LOAD_SYMBOL(api, str_hash, "g_str_hash");
  LOAD_SYMBOL(api, str_equal, "g_str_equal");
  LOAD_SYMBOL(api, service_search_sync, "secret_service_search_sync");
  LOAD_SYMBOL(api, item_get_locked, "secret_item_get_locked");
  LOAD_SYMBOL(api, item_load_secret_sync, "secret_item_load_secret_sync");
  LOAD_SYMBOL(api, item_get_secret, "secret_item_get_secret");
  LOAD_SYMBOL(api, item_set_secret_sync, "secret_item_set_secret_sync");
  LOAD_SYMBOL(api, item_delete_sync, "secret_item_delete_sync");
  LOAD_SYMBOL(api, dbus_proxy_get_object_path, "g_dbus_proxy_get_object_path");
  LOAD_SYMBOL(api, collection_for_alias_sync,
              "secret_collection_for_alias_sync");
  LOAD_SYMBOL(api, collection_get_locked, "secret_collection_get_locked");
  LOAD_SYMBOL(api, item_create_sync, "secret_item_create_sync");
  LOAD_SYMBOL(api, value_new, "secret_value_new");
  LOAD_SYMBOL(api, value_get, "secret_value_get");
  LOAD_SYMBOL(api, value_unref, "secret_value_unref");
  LOAD_SYMBOL(api, list_free_full, "g_list_free_full");
  LOAD_SYMBOL(api, object_unref, "g_object_unref");
  LOAD_SYMBOL(api, error_free, "g_error_free");
  return true;

load_failed:
  (void)dlclose(api->library);
  api->library = NULL;
  return false;
}

#undef LOAD_SYMBOL

static void unload_secret_api(struct secret_api *api) {
  if (api->library != NULL) {
    (void)dlclose(api->library);
    api->library = NULL;
  }
}

static void report_error(struct secret_api *api, const char *operation,
                         GError **error) {
  if ((error != NULL) && (*error != NULL)) {
    (void)fprintf(stderr, "Secret Service %s failed: %s\n", operation,
                  (*error)->message != NULL ? (*error)->message
                                            : "backend error");
    api->error_free(*error);
    *error = NULL;
    return;
  }
  (void)fprintf(stderr, "Secret Service %s failed\n", operation);
}

static bool initialize_storage_context(struct secret_api *api,
                                       struct storage_context *context,
                                       const char *service_name,
                                       const char *account_name) {
  GError *error = NULL;

  (void)memset(context, 0, sizeof *context);
  context->api = api;
  context->service = api->service_open_sync(
      api->service_get_type(), NULL, SECRET_SERVICE_OPEN_SESSION, NULL, &error);
  if (context->service == NULL) {
    report_error(api, "session initialization", &error);
    return false;
  }

  context->schema = api->schema_new(
      "com.tetsuo.agenc.credentials.v1", SECRET_SCHEMA_DONT_MATCH_NAME,
      "service", SECRET_SCHEMA_ATTRIBUTE_STRING, "account",
      SECRET_SCHEMA_ATTRIBUTE_STRING, NULL);
  if (context->schema == NULL) {
    (void)fprintf(stderr, "Secret Service schema initialization failed\n");
    return false;
  }

  context->attributes = api->hash_table_new(api->str_hash, api->str_equal);
  if (context->attributes == NULL) {
    (void)fprintf(stderr, "Secret Service attribute allocation failed\n");
    return false;
  }
  if (!api->hash_table_insert(context->attributes, "service", service_name) ||
      !api->hash_table_insert(context->attributes, "account", account_name)) {
    (void)fprintf(stderr, "Secret Service attribute initialization failed\n");
    return false;
  }
  return true;
}

static void destroy_storage_context(struct storage_context *context) {
  if (context->attributes != NULL) {
    context->api->hash_table_unref(context->attributes);
    context->attributes = NULL;
  }
  if (context->schema != NULL) {
    context->api->schema_unref(context->schema);
    context->schema = NULL;
  }
  if (context->service != NULL) {
    context->api->object_unref(context->service);
    context->service = NULL;
  }
}

static bool search_items(struct storage_context *context,
                         struct search_result *result) {
  GError *error = NULL;
  GList *cursor;

  (void)memset(result, 0, sizeof *result);
  result->items = context->api->service_search_sync(
      context->service, context->schema, context->attributes,
      SECRET_SEARCH_ALL, NULL, &error);
  if (error != NULL) {
    report_error(context->api, "exact-item search", &error);
    if (result->items != NULL) {
      context->api->list_free_full(result->items,
                                   context->api->object_unref);
      result->items = NULL;
    }
    return false;
  }

  for (cursor = result->items; cursor != NULL; cursor = cursor->next) {
    if (result->count == SIZE_MAX) {
      (void)fprintf(stderr, "Secret Service returned too many matching items\n");
      context->api->list_free_full(result->items,
                                   context->api->object_unref);
      result->items = NULL;
      result->item = NULL;
      result->count = 0U;
      return false;
    }
    result->count += 1U;
    if (result->count == 1U) {
      result->item = cursor->data;
    }
  }
  return true;
}

static void destroy_search_result(struct secret_api *api,
                                  struct search_result *result) {
  if (result->items != NULL) {
    api->list_free_full(result->items, api->object_unref);
    result->items = NULL;
  }
  result->item = NULL;
  result->count = 0U;
}

static bool require_unique_item(const struct search_result *result) {
  if (result->count <= 1U) {
    return true;
  }
  (void)fprintf(stderr,
                "Secret Service contains multiple records for the exact AgenC identity; refusing an ambiguous operation\n");
  return false;
}

static bool write_all_stdout(const char *data, size_t length) {
  size_t written = 0U;

  while (written < length) {
    const size_t chunk = fwrite(data + written, 1U, length - written, stdout);
    if (chunk == 0U) {
      (void)fprintf(stderr, "Secret Service helper could not write its result\n");
      return false;
    }
    written += chunk;
  }
  if (fflush(stdout) != 0) {
    (void)fprintf(stderr, "Secret Service helper could not flush its result\n");
    return false;
  }
  return true;
}

static int read_secret(struct storage_context *context) {
  struct search_result search;
  GError *error = NULL;
  SecretValue *value;
  const char *secret;
  size_t secret_length = 0U;
  int result = 1;

  if (!search_items(context, &search)) {
    return 1;
  }
  if (!require_unique_item(&search)) {
    goto cleanup;
  }
  if (search.count == 0U) {
    result = 2;
    goto cleanup;
  }
  if (context->api->item_get_locked(search.item)) {
    (void)fprintf(stderr, "Secret Service exact item is locked\n");
    goto cleanup;
  }
  if (!context->api->item_load_secret_sync(search.item, NULL, &error)) {
    report_error(context->api, "secret load", &error);
    goto cleanup;
  }
  value = context->api->item_get_secret(search.item);
  if (value == NULL) {
    (void)fprintf(stderr, "Secret Service returned an empty credential value\n");
    goto cleanup;
  }
  secret = context->api->value_get(value, &secret_length);
  if ((secret == NULL) || (secret_length == 0U)) {
    (void)fprintf(stderr, "Secret Service returned an empty credential value\n");
    goto cleanup;
  }
  if (secret_length >= MAX_SECRET_BYTES) {
    (void)fprintf(stderr,
                  "Secret Service credential exceeds the %u-byte helper limit\n",
                  MAX_SECRET_BYTES);
    goto cleanup;
  }
  if (!write_all_stdout(secret, secret_length)) {
    goto cleanup;
  }
  result = 0;

cleanup:
  destroy_search_result(context->api, &search);
  return result;
}

static bool read_stdin_secret(char **output, size_t *output_length) {
  char *buffer = NULL;
  size_t capacity = 4096U;
  size_t length = 0U;
  bool success = false;

  *output = NULL;
  *output_length = 0U;
  buffer = malloc(capacity);
  if (buffer == NULL) {
    (void)fprintf(stderr, "Secret Service helper could not allocate input memory\n");
    return false;
  }

  for (;;) {
    size_t read_count;

    if (length == capacity) {
      size_t next_capacity;
      char *replacement;

      if (capacity >= MAX_SECRET_BYTES) {
        (void)fprintf(stderr,
                      "Secret Service credential exceeds the %u-byte helper limit\n",
                      MAX_SECRET_BYTES);
        goto cleanup;
      }
      next_capacity = capacity * 2U;
      if ((next_capacity < capacity) ||
          (next_capacity > (MAX_SECRET_BYTES + 1U))) {
        next_capacity = MAX_SECRET_BYTES + 1U;
      }
      replacement = realloc(buffer, next_capacity);
      if (replacement == NULL) {
        (void)fprintf(stderr,
                      "Secret Service helper could not grow input memory\n");
        goto cleanup;
      }
      buffer = replacement;
      capacity = next_capacity;
    }

    read_count = fread(buffer + length, 1U, capacity - length, stdin);
    length += read_count;
    if (ferror(stdin)) {
      (void)fprintf(stderr, "Secret Service helper could not read stdin\n");
      goto cleanup;
    }
    if (feof(stdin)) {
      break;
    }
  }

  if (length == 0U) {
    (void)fprintf(stderr, "Secret Service helper received an empty credential\n");
    goto cleanup;
  }
  if (length >= MAX_SECRET_BYTES) {
    (void)fprintf(stderr,
                  "Secret Service credential exceeds the %u-byte helper limit\n",
                  MAX_SECRET_BYTES);
    goto cleanup;
  }

  *output = buffer;
  *output_length = length;
  buffer = NULL;
  success = true;

cleanup:
  if (buffer != NULL) {
    explicit_bzero(buffer, capacity);
    free(buffer);
  }
  return success;
}

static bool verify_item_payload(struct storage_context *context,
                                SecretItem *expected_item,
                                SecretItem *actual_item,
                                const char *expected_payload,
                                size_t expected_payload_length) {
  GError *error = NULL;
  SecretValue *actual_value;
  const char *actual_payload;
  const char *expected_path;
  const char *actual_path;
  size_t actual_payload_length = 0U;
  size_t index;
  unsigned char difference = 0U;

  expected_path =
      context->api->dbus_proxy_get_object_path((gpointer)expected_item);
  actual_path = context->api->dbus_proxy_get_object_path((gpointer)actual_item);
  if ((expected_path == NULL) || (actual_path == NULL) ||
      (strcmp(expected_path, actual_path) != 0)) {
    (void)fprintf(stderr,
                  "Secret Service exact-item verification found a different item\n");
    return false;
  }
  if (context->api->item_get_locked(actual_item)) {
    (void)fprintf(stderr,
                  "Secret Service exact item became locked during verification\n");
    return false;
  }
  if (!context->api->item_load_secret_sync(actual_item, NULL, &error)) {
    report_error(context->api, "post-update secret load", &error);
    return false;
  }
  actual_value = context->api->item_get_secret(actual_item);
  if (actual_value == NULL) {
    (void)fprintf(stderr,
                  "Secret Service returned no post-update credential value\n");
    return false;
  }
  actual_payload =
      context->api->value_get(actual_value, &actual_payload_length);
  if ((actual_payload == NULL) ||
      (actual_payload_length != expected_payload_length)) {
    (void)fprintf(stderr,
                  "Secret Service post-update credential verification failed\n");
    return false;
  }
  for (index = 0U; index < expected_payload_length; index += 1U) {
    difference |= (unsigned char)actual_payload[index] ^
                  (unsigned char)expected_payload[index];
  }
  if (difference != 0U) {
    (void)fprintf(stderr,
                  "Secret Service post-update credential verification failed\n");
    return false;
  }
  return true;
}

static void remove_unverified_created_item(struct storage_context *context,
                                           SecretItem *created) {
  GError *error = NULL;

  /*
   * Secret Service has no compare-and-swap primitive. Current AgenC writers
   * serialize above this helper, and migration requires retired writers to be
   * quiescent. On failed verification, compensate only the exact item proxy
   * returned by this invocation's create. Never restore a captured old value:
   * that could overwrite a newer writer after an ambiguous backend failure.
   */
  if ((created != NULL) &&
      !context->api->item_delete_sync(created, NULL, &error)) {
    report_error(context->api, "unverified-creation cleanup", &error);
  }
}

static int update_secret(struct storage_context *context, const char *payload,
                         size_t payload_length) {
  struct search_result search;
  struct search_result verification;
  GError *error = NULL;
  SecretCollection *collection = NULL;
  SecretItem *created = NULL;
  SecretItem *updated = NULL;
  SecretValue *value = NULL;
  int result = 1;

  value = context->api->value_new(payload, (ptrdiff_t)payload_length,
                                  "application/json; charset=utf-8");
  if (value == NULL) {
    (void)fprintf(stderr, "Secret Service value allocation failed\n");
    return 1;
  }
  if (!search_items(context, &search)) {
    goto cleanup_value;
  }
  if (!require_unique_item(&search)) {
    goto cleanup_search;
  }

  if (search.count == 1U) {
    if (context->api->item_get_locked(search.item)) {
      (void)fprintf(stderr, "Secret Service exact item is locked\n");
      goto cleanup_search;
    }
    if (!context->api->item_set_secret_sync(search.item, value, NULL, &error)) {
      report_error(context->api, "exact-item update", &error);
      goto cleanup_search;
    }
    updated = search.item;
  } else {
    collection = context->api->collection_for_alias_sync(
        context->service, "default", 0, NULL, &error);
    if (collection == NULL) {
      report_error(context->api, "default-collection lookup", &error);
      goto cleanup_search;
    }
    if (context->api->collection_get_locked(collection)) {
      (void)fprintf(stderr, "Secret Service default collection is locked\n");
      goto cleanup_search;
    }
    created = context->api->item_create_sync(
        collection, context->schema, context->attributes,
        "AgenC credentials", value, SECRET_ITEM_CREATE_NONE, NULL, &error);
    if (created == NULL) {
      report_error(context->api, "exact-item creation", &error);
      goto cleanup_search;
    }
  }

  if (!search_items(context, &verification)) {
    remove_unverified_created_item(context, created);
    goto cleanup_search;
  }
  if (verification.count != 1U) {
    (void)fprintf(stderr,
                  "Secret Service exact-item verification found %zu matching records; refusing success\n",
                  verification.count);
    remove_unverified_created_item(context, created);
    destroy_search_result(context->api, &verification);
    goto cleanup_search;
  }
  if (!verify_item_payload(context, updated != NULL ? updated : created,
                           verification.item, payload, payload_length)) {
    remove_unverified_created_item(context, created);
    destroy_search_result(context->api, &verification);
    goto cleanup_search;
  }
  destroy_search_result(context->api, &verification);
  result = 0;

cleanup_search:
  destroy_search_result(context->api, &search);
  if (created != NULL) {
    context->api->object_unref(created);
  }
  if (collection != NULL) {
    context->api->object_unref(collection);
  }
cleanup_value:
  context->api->value_unref(value);
  return result;
}

static int delete_secret(struct storage_context *context) {
  struct search_result search;
  struct search_result verification;
  GError *error = NULL;
  int result = 1;

  if (!search_items(context, &search)) {
    return 1;
  }
  if (!require_unique_item(&search)) {
    goto cleanup;
  }
  if (search.count == 0U) {
    result = 2;
    goto cleanup;
  }
  if (context->api->item_get_locked(search.item)) {
    (void)fprintf(stderr, "Secret Service exact item is locked\n");
    goto cleanup;
  }
  if (!context->api->item_delete_sync(search.item, NULL, &error)) {
    report_error(context->api, "exact-item deletion", &error);
    goto cleanup;
  }
  if (!search_items(context, &verification)) {
    goto cleanup;
  }
  if (verification.count != 0U) {
    (void)fprintf(stderr,
                  "Secret Service exact-item deletion could not be verified\n");
    destroy_search_result(context->api, &verification);
    goto cleanup;
  }
  destroy_search_result(context->api, &verification);
  result = 0;

cleanup:
  destroy_search_result(context->api, &search);
  return result;
}

static bool valid_identity(const char *value) {
  const size_t length = strlen(value);
  return (length > 0U) && (length <= MAX_IDENTITY_BYTES);
}

static void print_usage(const char *program) {
  (void)fprintf(stderr, "Usage: %s <read|write|delete> <service> <account>\n",
                program);
}

int main(int argc, char **argv) {
  struct secret_api api;
  struct storage_context context;
  char *payload = NULL;
  size_t payload_length = 0U;
  int result = 1;

  if ((argc != 4) ||
      ((strcmp(argv[1], "read") != 0) &&
       (strcmp(argv[1], "write") != 0) &&
       (strcmp(argv[1], "delete") != 0))) {
    print_usage(argv[0]);
    return 1;
  }
  if (!valid_identity(argv[2]) || !valid_identity(argv[3])) {
    (void)fprintf(stderr,
                  "Secret Service service and account identities must contain 1..%u bytes\n",
                  MAX_IDENTITY_BYTES);
    return 1;
  }
  if ((strcmp(argv[1], "write") == 0) &&
      !read_stdin_secret(&payload, &payload_length)) {
    return 1;
  }
  if (!load_secret_api(&api)) {
    goto cleanup_payload;
  }
  if (!initialize_storage_context(&api, &context, argv[2], argv[3])) {
    destroy_storage_context(&context);
    unload_secret_api(&api);
    goto cleanup_payload;
  }

  if (strcmp(argv[1], "read") == 0) {
    result = read_secret(&context);
  } else if (strcmp(argv[1], "write") == 0) {
    result = update_secret(&context, payload, payload_length);
  } else {
    result = delete_secret(&context);
  }

  destroy_storage_context(&context);
  unload_secret_api(&api);

cleanup_payload:
  if (payload != NULL) {
    explicit_bzero(payload, payload_length);
    free(payload);
  }
  return result;
}
