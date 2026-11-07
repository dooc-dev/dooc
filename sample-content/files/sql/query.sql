SELECT author, COUNT(*) AS documents
FROM documents
WHERE status = 'published'
GROUP BY author
ORDER BY documents DESC;
