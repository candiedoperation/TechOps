const isProd = process.env.NODE_ENV === "production";
const basePath = isProd ? "" : "";

// Function to prefix a path onto all images
// With new domain name, we dont prefix them with anything
export function prefixPath(path: string) {
  return `${basePath}${path}`;
}
