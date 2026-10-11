grep -n "^export" core/*.ts core/*.tsx | while IFS=: read -r file line rest; do
  name=$(echo "$rest" | sed -E 's/^export (async |default |)(function|class|const|type|interface|enum) +([A-Za-z0-9_]+).*/\3/')
  if [ "$name" = "$rest" ]; then echo "SKIP: $file:$line $rest"; continue; fi
  ext=$(grep -rnw --include="*.ts" --include="*.tsx" --exclude="$(basename $file)" "$name" core views index.tsx intent.tsx translation_ui_provider.tsx __preview-screen-result.tsx __preview-screen-result-b.tsx 2>/dev/null | wc -l)
  tests=$(grep -rnw --include="*.ts" --include="*.tsx" "$name" tests 2>/dev/null | wc -l)
  echo "$file:$line $name ext=$ext tests=$tests"
done
