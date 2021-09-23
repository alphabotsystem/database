source /run/secrets/alpha-service/key
if [[ $PRODUCTION_MODE == "1" ]]
then
	node app/database.js
else
	node app/database.js
fi