from collections import Counter

formats = ["svg", "png", "csv", "svg", "html"]
for extension, count in Counter(formats).items():
    print(f"{extension}: {count}")
