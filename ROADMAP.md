# Roadmap

Planned changes to the scripts in this repo. Each one says what it's waiting on.

## Sticker Outline: fewer nodes

**Waiting on:** Affinity adding an offset path (Contour) or Expand Stroke command to its
scripting API.

Today the script builds the outline from many small pieces (bands along every curve and circles
at the corners) and joins them with Add, because that's all the scripting API allows. The result
is right, but it has far more nodes than an offset path drawn by hand.

Once Affinity's scripting can offset a path, the script can work the way you would by hand:

1. Join copies of the selected artwork into one shape.
2. Offset that shape by the chosen distance.
3. Fill the holes, if Fill holes is on.

The outline would have about as many nodes as a hand-drawn one, and the note about node count in
the README can go.
