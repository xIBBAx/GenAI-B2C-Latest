import os
import pymongo
from dotenv import load_dotenv

load_dotenv()

def main():
    # Connect to Mongo
    url = os.environ.get("CONNECTION_URL")
    if not url:
        raise RuntimeError("CONNECTION_URL env var is missing")

    client = pymongo.MongoClient(url)
    db = client["nyayamind"]

    # Get distinct state names
    try:
        states = db["state_acts"].distinct("State Name")
        # Filter only valid non-empty strings
        states = [s.strip() for s in states if isinstance(s, str) and s.strip()]
        states.sort(key=lambda x: x.lower())

        print("Found state names in state_acts collection:")
        for s in states:
            print("-", s)
    except Exception as e:
        print("Error while fetching state names:", e)

if __name__ == "__main__":
    main()