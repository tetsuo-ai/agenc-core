/**
 * Preapproved-host allowlist for `WebFetch`.
 *
 * Common dev/docs domains that are known-safe for GET-only fetches.
 * AgenC surfaces this via the web fetch tool result so the model
 * knows when a host is well-known; the access-control gate itself
 * remains the standard permission classifier.
 *
 * Security note: this list applies ONLY to WebFetch (HTTPS GET).
 * Sandbox network policy must NOT
 * inherit it — arbitrary network access (POST / uploads) to hosts in
 * this list could enable data exfiltration, since some entries
 * (huggingface.co, kaggle.com, nuget.org) accept uploads.
 *
 * @module
 */

export const PREAPPROVED_HOSTS: ReadonlySet<string> = new Set([
  // AgenC + protocol surfaces
  "agenc.tech",
  "modelcontextprotocol.io",
  "github.com/anthropics",
  "agentskills.io",

  // Top programming languages
  "docs.python.org",
  "en.cppreference.com",
  "docs.oracle.com",
  "learn.microsoft.com",
  "developer.mozilla.org",
  "go.dev",
  "pkg.go.dev",
  "www.php.net",
  "docs.swift.org",
  "kotlinlang.org",
  "ruby-doc.org",
  "doc.rust-lang.org",
  "www.typescriptlang.org",

  // Web & JavaScript frameworks/libraries
  "react.dev",
  "angular.io",
  "vuejs.org",
  "nextjs.org",
  "expressjs.com",
  "nodejs.org",
  "bun.sh",
  "jquery.com",
  "getbootstrap.com",
  "tailwindcss.com",
  "d3js.org",
  "threejs.org",
  "redux.js.org",
  "webpack.js.org",
  "jestjs.io",
  "reactrouter.com",

  // Python frameworks & libraries
  "docs.djangoproject.com",
  "flask.palletsprojects.com",
  "fastapi.tiangolo.com",
  "pandas.pydata.org",
  "numpy.org",
  "www.tensorflow.org",
  "pytorch.org",
  "scikit-learn.org",
  "matplotlib.org",
  "requests.readthedocs.io",
  "jupyter.org",

  // PHP frameworks
  "laravel.com",
  "symfony.com",
  "wordpress.org",

  // Java frameworks & libraries
  "docs.spring.io",
  "hibernate.org",
  "tomcat.apache.org",
  "gradle.org",
  "maven.apache.org",

  // .NET & C# frameworks
  "asp.net",
  "dotnet.microsoft.com",
  "nuget.org",
  "blazor.net",

  // Mobile development
  "reactnative.dev",
  "docs.flutter.dev",
  "developer.apple.com",
  "developer.android.com",

  // Data science & machine learning
  "keras.io",
  "spark.apache.org",
  "huggingface.co",
  "www.kaggle.com",

  // Databases
  "www.mongodb.com",
  "redis.io",
  "www.postgresql.org",
  "dev.mysql.com",
  "www.sqlite.org",
  "graphql.org",
  "prisma.io",

  // Cloud & DevOps
  "docs.aws.amazon.com",
  "cloud.google.com",
  "kubernetes.io",
  "www.docker.com",
  "www.terraform.io",
  "www.ansible.com",
  "vercel.com/docs",
  "docs.netlify.com",
  "devcenter.heroku.com",

  // Testing & monitoring
  "cypress.io",
  "selenium.dev",

  // Game development
  "docs.unity.com",
  "docs.unrealengine.com",

  // Other essential tools
  "git-scm.com",
  "nginx.org",
  "httpd.apache.org",
]);

// Split once at module load so lookups are O(1) Set.has() for the
// common hostname-only case, falling back to a small per-host
// path-prefix list for path-scoped entries (e.g. "github.com/anthropics").
const HOSTNAME_ONLY = new Set<string>();
const PATH_PREFIXES = new Map<string, string[]>();
for (const entry of PREAPPROVED_HOSTS) {
  const slash = entry.indexOf("/");
  if (slash === -1) {
    HOSTNAME_ONLY.add(entry);
  } else {
    const host = entry.slice(0, slash);
    const path = entry.slice(slash);
    const list = PATH_PREFIXES.get(host);
    if (list) list.push(path);
    else PATH_PREFIXES.set(host, [path]);
  }
}

export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  if (HOSTNAME_ONLY.has(hostname)) return true;
  const prefixes = PATH_PREFIXES.get(hostname);
  if (prefixes) {
    for (const prefix of prefixes) {
      // Path segment boundaries: "/anthropics" must not match
      // "/anthropics-evil/malware". Only exact match or the prefix
      // followed by "/".
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
    }
  }
  return false;
}

export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isPreapprovedHost(parsed.hostname, parsed.pathname);
  } catch {
    return false;
  }
}
