# Trained detector files

Put these two files here after training with `training/train_fasteners.ipynb`:

- `fasteners.onnx` - the trained model
- `classes.json` - the fastener types, in the order the model uses

The **Detect** tab of the site loads them from this folder. Until they are here, it says there is no trained detector yet.
