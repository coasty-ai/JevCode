import argparse, json
p = argparse.ArgumentParser()
p.add_argument('--output')
a = p.parse_args()
json.dump({"answer": 42}, open(a.output, 'w'))
