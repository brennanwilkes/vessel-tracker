UPDATE vessels
SET max_extent = CASE
  WHEN EXISTS (SELECT 1 FROM positions WHERE positions.mmsi = vessels.mmsi AND tier = 'global') THEN 'global'
  WHEN EXISTS (SELECT 1 FROM positions WHERE positions.mmsi = vessels.mmsi AND tier = 'local')  THEN 'local'
  ELSE 'direct'
END
WHERE of_interest = 1;
