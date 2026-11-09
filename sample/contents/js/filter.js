const items = ["draft", "review", "published"];
export function visibleItems(query) {
  return items.filter((item) =>
    item.includes(query.trim().toLowerCase())
  );
}
