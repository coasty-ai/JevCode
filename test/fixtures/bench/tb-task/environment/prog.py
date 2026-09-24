import argparse, json, sys
p = argparse.ArgumentParser()
p.add_argument('--output')
a = p.parse_args()
# bug: writes 41
json.dump({"answer": 41}, open(a.output, 'w'))
